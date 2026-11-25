(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.WordSearchEngine = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const CATALOG_GENERATION = 'replacement-v1';
  const DIRECTIONS = [
    [-1, -1], [-1, 0], [-1, 1], [0, -1],
    [0, 1], [1, -1], [1, 0], [1, 1]
  ];
  const PROFILES = Object.freeze({
    Easy: { rows: 12, cols: 10, targets: 8, min: 3, max: 10, traps: 0, prefix: [2, 3] },
    Medium: { rows: 14, cols: 12, targets: 12, min: 3, max: 10, traps: 2, prefix: [2, 3] },
    Hard: { rows: 16, cols: 14, targets: 16, min: 3, max: 13, traps: 3, prefix: [3, 5] }
  });

  function normalizeTrapRange(difficulty, trapRange) {
    const base = typeof difficulty === 'string' && Object.hasOwn(PROFILES, difficulty) && PROFILES[difficulty];
    assert(base, 'difficulty must be Easy, Medium, or Hard.');
    let min, max;
    if (Array.isArray(trapRange)) {
      assert(trapRange.length === 2, 'trap range must contain two bounds.');
      [min, max] = trapRange;
    } else {
      assert(trapRange !== null && typeof trapRange === 'object' &&
        Object.keys(trapRange).sort().join(',') === 'max,min', 'trap range must contain exactly min and max.');
      ({ min, max } = trapRange);
    }
    assert(Number.isInteger(min) && Number.isInteger(max), 'trap range bounds must be integers.');
    const lower = difficulty === 'Easy' ? 0 : difficulty === 'Medium' ? 1 : 3;
    assert(min >= lower && max <= base.targets && min <= max &&
      (difficulty !== 'Easy' || max === 0), `${difficulty} trap range is outside legal bounds.`);
    return { min, max };
  }

  function profileFor(difficulty, trapCount, trapRange) {
    const base = typeof difficulty === 'string' && Object.hasOwn(PROFILES, difficulty) && PROFILES[difficulty];
    assert(base, 'difficulty must be Easy, Medium, or Hard.');
    const bounds = trapRange === undefined ? undefined : normalizeTrapRange(difficulty, trapRange);
    const count = trapCount === undefined ? (bounds ? bounds.min : base.traps) : trapCount;
    assert(Number.isInteger(count), 'trapCount must be an integer.');
    if (bounds) assert(count >= bounds.min && count <= bounds.max, 'trapCount must be inside trapRange.');
    else if (difficulty === 'Hard') assert(count >= 3 && count <= 16, 'Hard trapCount must be between 3 and 16.');
    else assert(count === base.traps, `${difficulty} trapCount must remain ${base.traps}.`);
    return { ...base, traps: count, traps_min: bounds ? bounds.min : count,
      traps_max: bounds ? bounds.max : count, prefix: [...base.prefix],
      ...(bounds ? { trapRange: { ...bounds } } : {}) };
  }

  function declaredTrapCount(raw) {
    if (!Object.hasOwn(raw, 'trapCount')) return undefined;
    assert(Number.isInteger(raw.trapCount), 'trapCount must be an integer.');
    return raw.trapCount;
  }

  function declaredTrapRange(raw) {
    if (!Object.hasOwn(raw, 'trapRange')) return undefined;
    assert(raw.trapRange !== null && typeof raw.trapRange === 'object' && !Array.isArray(raw.trapRange),
      'trapRange metadata must be an object containing min and max.');
    return normalizeTrapRange(raw.difficulty, raw.trapRange);
  }

  function seedProfile(raw, requestedTrapCount, requestedTrapRange) {
    const bounds = declaredTrapRange(raw);
    if (bounds) assert(Object.hasOwn(raw, 'trapCount'), 'trapRange requires actual trapCount metadata.');
    const profile = profileFor(raw.difficulty, declaredTrapCount(raw), bounds);
    if (requestedTrapRange !== undefined) {
      const requested = normalizeTrapRange(raw.difficulty, requestedTrapRange);
      assert(profile.traps_min === requested.min && profile.traps_max === requested.max,
        'declared trapRange differs from requested trap range.');
    }
    if (requestedTrapCount !== undefined) {
      const requested = profileFor(raw.difficulty, requestedTrapCount, bounds).traps;
      assert(profile.traps === requested, `declared trapCount ${profile.traps} differs from requested trap count ${requested}.`);
    }
    return profile;
  }

  function getDimensions(raw) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const validDimension = value => Number.isInteger(value) && value >= 4 && value <= 20;
    const hasRows = 'rows' in raw;
    const hasCols = 'cols' in raw;
    const hasSize = 'size' in raw;
    if (hasRows || hasCols) {
      if (!hasRows || !hasCols || !validDimension(raw.rows) || !validDimension(raw.cols)) return null;
      if (hasSize && (!validDimension(raw.size) || raw.size !== raw.rows || raw.size !== raw.cols)) return null;
      return { rows: raw.rows, cols: raw.cols };
    }
    return hasSize && validDimension(raw.size) ? { rows: raw.size, cols: raw.size } : null;
  }

  function isCell(cell, dimensions) {
    return cell !== null && typeof cell === 'object' && !Array.isArray(cell) &&
      Number.isInteger(cell.row) && Number.isInteger(cell.col) &&
      cell.row >= 0 && cell.row < dimensions.rows && cell.col >= 0 && cell.col < dimensions.cols;
  }

  function getLine(start, end, board) {
    const dimensions = Number.isInteger(board) && board >= 1 && board <= 100
      ? { rows: board, cols: board } : getDimensions(board);
    if (!dimensions || !isCell(start, dimensions) || !isCell(end, dimensions)) return [];
    const rowDistance = end.row - start.row;
    const colDistance = end.col - start.col;
    if (rowDistance !== 0 && colDistance !== 0 &&
      Math.abs(rowDistance) !== Math.abs(colDistance)) return [];
    const length = Math.max(Math.abs(rowDistance), Math.abs(colDistance)) + 1;
    const rowStep = Math.sign(rowDistance);
    const colStep = Math.sign(colDistance);
    return Array.from({ length }, (_, index) => ({
      row: start.row + index * rowStep,
      col: start.col + index * colStep
    }));
  }

  // Drag distances are continuous cell units, measured from the centre of the
  // start cell. Snap the angle first, then project the distance onto that line.
  // `entry` is how far into a letter (0-0.5 of a cell) the drag must reach
  // before that letter joins the line; 0 joins it on crossing its edge.
  function getDragLine(start, distance, board, entry = 0) {
    const dimensions = Number.isInteger(board) && board >= 1 && board <= 100
      ? { rows: board, cols: board } : getDimensions(board);
    if (!dimensions || !isCell(start, dimensions) || !distance ||
      !Number.isFinite(distance.row) || !Number.isFinite(distance.col)) return [];
    const rows = Math.abs(distance.row), cols = Math.abs(distance.col);
    if (!rows && !cols) return [{ ...start }];
    const angleBoundary = Math.tan(Math.PI / 8);
    let rowStep = rows <= cols * angleBoundary ? 0 : Math.sign(distance.row);
    let colStep = cols <= rows * angleBoundary ? 0 : Math.sign(distance.col);
    const limit = (rowDirection, colDirection) => Math.min(
      rowDirection ? (rowDirection > 0 ? dimensions.rows - 1 - start.row : start.row) : Infinity,
      colDirection ? (colDirection > 0 ? dimensions.cols - 1 - start.col : start.col) : Infinity);
    // At an edge, the snapped direction can point off the board, collapsing the
    // drag to one letter. Then use the neighbouring direction nearer the drag
    // (at most 45 degrees away). Elsewhere, snapping is unchanged.
    if (limit(rowStep, colStep) === 0) {
      const snapped = Math.atan2(rowStep, colStep);
      const turn = Math.atan2(Math.sin(Math.atan2(distance.row, distance.col) - snapped),
        Math.cos(Math.atan2(distance.row, distance.col) - snapped));
      if (turn) {
        const neighbour = snapped + Math.sign(turn) * Math.PI / 4;
        const row = Math.round(Math.sin(neighbour)), col = Math.round(Math.cos(neighbour));
        if (limit(row, col) > 0) { rowStep = row; colStep = col; }
      }
    }
    const projected = (distance.row * rowStep + distance.col * colStep) /
      (rowStep * rowStep + colStep * colStep);
    const join = Number.isFinite(entry) ? Math.min(.5, Math.max(0, entry)) : 0;
    const steps = Math.max(0, Math.min(Math.round(projected - join), limit(rowStep, colStep)));
    return getLine(start, { row: start.row + rowStep * steps, col: start.col + colStep * steps }, board);
  }

  function pathKey(start, end) {
    const first = `${start.row},${start.col}`;
    const last = `${end.row},${end.col}`;
    return first < last ? `${first}:${last}` : `${last}:${first}`;
  }

  function findOccurrences(grid, word) {
    const dimensions = { rows: grid.length, cols: grid[0].length };
    const occurrences = new Set();
    for (let row = 0; row < dimensions.rows; row += 1) {
      for (let col = 0; col < dimensions.cols; col += 1) {
        if (grid[row][col] !== word[0]) continue;
        for (const [rowStep, colStep] of DIRECTIONS) {
          const end = {
            row: row + rowStep * (word.length - 1),
            col: col + colStep * (word.length - 1)
          };
          if (!isCell(end, dimensions)) continue;
          let matches = true;
          for (let index = 1; index < word.length; index += 1) {
            if (grid[row + rowStep * index][col + colStep * index] !== word[index]) {
              matches = false;
              break;
            }
          }
          if (matches) occurrences.add(pathKey({ row, col }, end));
        }
      }
    }
    return occurrences;
  }

  function assert(condition, message) {
    if (!condition) throw new Error(`Invalid seed: ${message}`);
  }

  function textField(raw, field, maxLength) {
    assert(typeof raw[field] === 'string' && raw[field].trim().length > 0 &&
      raw[field].trim().length <= maxLength,
    `${field} must be a nonempty string of at most ${maxLength} characters.`);
    return raw[field].trim();
  }

  function readEndpoint(raw, word, label, dimensions) {
    assert(Array.isArray(raw) && raw.length === 2,
      `${word} ${label} must be a [row, col] pair.`);
    const cell = { row: raw[0], col: raw[1] };
    assert(isCell(cell, dimensions), `${word} ${label} must be inside the grid using zero-based integer coordinates.`);
    return cell;
  }

  function validateSeed(raw, requestedTrapCount, requestedTrapRange) {
    assert(raw !== null && typeof raw === 'object' && !Array.isArray(raw), 'expected a JSON object.');
    assert(raw.version === 2, 'version must be 2.');
    assert(raw.catalogGeneration === CATALOG_GENERATION, 'This puzzle belongs to a retired library.');
    const title = textField(raw, 'title', 120);
    const category = textField(raw, 'category', 80);
    assert(/^[A-Z][a-z]* [A-Z][a-z]*$/.test(title), 'title must contain exactly two title-case alphabetic words.');
    const profile = seedProfile(raw, requestedTrapCount, requestedTrapRange);
    assert(validID(raw.id, category, raw.difficulty), 'id must match Category_Difficulty_000001 with a positive six-digit number.');
    const dimensions = getDimensions(raw);
    assert(dimensions && dimensions.rows === profile.rows && dimensions.cols === profile.cols,
      `${raw.difficulty} requires ${profile.rows} rows and ${profile.cols} columns.`);
    const { rows, cols } = dimensions;
    assert(Array.isArray(raw.grid) && raw.grid.length === rows, `grid must have exactly ${rows} rows.`);
    const grid = Array.from(raw.grid, (row, index) => {
      assert(typeof row === 'string' && row.length === cols && /^[A-Z]+$/.test(row),
        `grid row ${index + 1} must contain exactly ${cols} uppercase A–Z letters.`);
      return row.split('');
    });
    assert(Array.isArray(raw.words) && raw.words.length === profile.targets,
      `words must contain exactly ${profile.targets} entries.`);
    assert(Array.isArray(raw.bonusWords) && raw.bonusWords.length === 3, 'bonusWords must contain exactly three entries.');
    const seen = new Set();
    const readWords = entries => Array.from(entries, (entry, index) => {
      assert(entry !== null && typeof entry === 'object' && !Array.isArray(entry), `word ${index + 1} must be an object.`);
      const word = entry.word;
      assert(typeof word === 'string' && /^[A-Z]+$/.test(word) && word.length >= profile.min && word.length <= profile.max,
        `word ${index + 1} must contain ${profile.min}–${profile.max} uppercase A–Z letters.`);
      assert(!seen.has(word), `word ${word} is listed more than once.`);
      seen.add(word);
      const start = readEndpoint(entry.start, word, 'start', dimensions);
      const end = readEndpoint(entry.end, word, 'end', dimensions);
      const cells = getLine(start, end, dimensions);
      assert(cells.length === word.length,
        `${word} must follow a straight horizontal, vertical, or diagonal line of ${word.length} cells.`);
      assert(cells.map(cell => grid[cell.row][cell.col]).join('') === word,
        `${word} does not match the letters between its start and end.`);
      return { word, start, end, cells };
    });
    const words = readWords(raw.words), bonusWords = readWords(raw.bonusWords);
    const answers = [...words, ...bonusWords];
    if (raw.difficulty === 'Easy') {
      assert(answers.filter(entry => entry.word.length >= 9).length <= 4, 'Easy allows at most four nine- or ten-letter answers.');
      assert(answers.every(entry => entry.end.col > entry.start.col ||
        (entry.end.col === entry.start.col && entry.end.row > entry.start.row)), 'Easy answers must read up-right, right, down-right, or down.');
    }
    for (let first = 0; first < answers.length; first += 1) {
      for (let second = first + 1; second < answers.length; second += 1) {
        const a = answers[first].word;
        const b = answers[second].word;
        const reversedA = a.split('').reverse().join('');
        assert(!a.includes(b) && !b.includes(a) && !reversedA.includes(b) && !b.includes(reversedA),
          `${a} and ${b} overlap as complete target words; choose separate words.`);
      }
    }
    for (const entry of answers) {
      const occurrences = findOccurrences(grid, entry.word);
      assert(occurrences.size === 1 && occurrences.has(pathKey(entry.start, entry.end)),
        `${entry.word} must appear exactly once in the grid (found ${occurrences.size} paths).`);
    }
    const normalizedTitle = title.replace(/\s+/g, '').toUpperCase();
    assert(answers.every(entry => !normalizedTitle.includes(entry.word)), 'title must not reveal a selected answer.');
    assert(Array.isArray(raw.traps) && raw.traps.length === profile.traps, `traps must contain exactly ${profile.traps} entries.`);
    const trapTargets = new Set(), trapCells = new Set();
    const traps = Array.from(raw.traps, entry => {
      assert(entry && typeof entry === 'object' && !Array.isArray(entry), 'each trap must be an object.');
      const target = words.find(word => word.word === entry.target);
      assert(target && !trapTargets.has(entry.target), 'each trap must identify a different listed target.');
      trapTargets.add(entry.target);
      assert(typeof entry.prefix === 'string' && entry.prefix.length >= profile.prefix[0] &&
        entry.prefix.length <= profile.prefix[1] && target.word.startsWith(entry.prefix) && entry.prefix.length < target.word.length,
      'trap prefix must match the beginning of its target within the difficulty range.');
      const start = readEndpoint(entry.start, entry.target, 'trap start', dimensions);
      const end = readEndpoint(entry.end, entry.target, 'trap end', dimensions);
      const divergence = readEndpoint(entry.divergence, entry.target, 'divergence', dimensions);
      const cells = getLine(start, end, dimensions);
      assert(cells.length === entry.prefix.length && cells.map(cell => grid[cell.row][cell.col]).join('') === entry.prefix,
        'trap prefix must match its grid path.');
      const dr = Math.sign(end.row - start.row), dc = Math.sign(end.col - start.col);
      assert(divergence.row === end.row + dr && divergence.col === end.col + dc &&
        grid[divergence.row][divergence.col] !== target.word[entry.prefix.length], 'trap must diverge immediately after its prefix.');
      assert(isCell({ row: start.row + dr * (target.word.length - 1), col: start.col + dc * (target.word.length - 1) }, dimensions),
        'trap must have room for its complete target.');
      for (const cell of [...cells, divergence]) {
        const key = `${cell.row},${cell.col}`;
        assert(!trapCells.has(key), 'traps cannot share cells.');
        trapCells.add(key);
      }
      return { target: entry.target, prefix: entry.prefix, start, end, divergence };
    });
    const seed = { catalogGeneration: CATALOG_GENERATION, version: 2, id: raw.id, title, category, difficulty: raw.difficulty, rows, cols, grid, words, bonusWords, traps };
    if (Object.hasOwn(raw, 'trapCount')) seed.trapCount = profile.traps;
    if (Object.hasOwn(raw, 'trapRange')) seed.trapRange = { min: profile.traps_min, max: profile.traps_max };
    return seed;
  }

  function validID(id, category, difficulty) {
    if (typeof id !== 'string' || typeof category !== 'string') return false;
    const slug = category.replace(/[^A-Za-z\s-]/g, '').trim().replace(/[\s-]+/g, '_');
    return /^WS2_[A-Za-z]+(?:_[A-Za-z]+)*_(?:Easy|Medium|Hard)_\d{6}$/.test(id) &&
      id.startsWith(`WS2_${slug}_${difficulty}_`) && Number(id.slice(-6)) > 0;
  }

  function validateManifest(raw) {
    if (!raw || raw.version !== 2 || raw.catalogGeneration !== CATALOG_GENERATION || !Array.isArray(raw.seeds)) throw new Error('The puzzle library is invalid.');
    const ids = new Set(), titles = new Map(), batchTitles = new Map();
    return raw.seeds.map(entry => {
      const profile = entry && Object.hasOwn(PROFILES, entry.difficulty) &&
        seedProfile(entry);
      if (!profile || !validID(entry.id, entry.category, entry.difficulty) || ids.has(entry.id) ||
          typeof entry.title !== 'string' || !/^[A-Z][a-z]* [A-Z][a-z]*$/.test(entry.title) || entry.title.length > 120 ||
          entry.category.length > 80 ||
          entry.rows !== profile.rows || entry.cols !== profile.cols || entry.path !== `seeds/${entry.id}.json` || !/^[a-f0-9]{64}$/.test(entry.contentSha256 || '')) {
        throw new Error('The puzzle library has an invalid or duplicate entry.');
      }
      const titleKey = entry.title.replace(/[^A-Za-z]/g, '').toLowerCase();
      const batch = entry.id.slice(-6);
      const batchScope = `${entry.category}\0${batch}`;
      const owner = titles.get(titleKey);
      if (owner && (owner.category !== entry.category || owner.batch !== batch ||
          owner.difficulties.has(entry.difficulty))) {
        throw new Error('The puzzle library has an invalid or duplicate entry.');
      }
      if (batchTitles.has(batchScope) && batchTitles.get(batchScope) !== titleKey) {
        throw new Error('The puzzle library has an invalid or duplicate entry.');
      }
      ids.add(entry.id);
      if (owner) owner.difficulties.add(entry.difficulty);
      else titles.set(titleKey, { category: entry.category, batch, difficulties: new Set([entry.difficulty]) });
      batchTitles.set(batchScope, titleKey);
      return { id: entry.id, title: entry.title, category: entry.category, difficulty: entry.difficulty,
        rows: entry.rows, cols: entry.cols, path: entry.path, wordCount: profile.targets,
        catalogGeneration: CATALOG_GENERATION, contentSha256: entry.contentSha256,
        ...(Object.hasOwn(entry, 'trapCount') ? { trapCount: profile.traps } : {}),
        ...(Object.hasOwn(entry, 'trapRange') ? { trapRange: { min: profile.traps_min, max: profile.traps_max } } : {}) };
    });
  }

  function matchSelection(puzzle, cells) {
    const dimensions = getDimensions(puzzle);
    if (!dimensions || !Array.isArray(puzzle.words) || !Array.isArray(cells) ||
      cells.length < 2 || cells.length > Math.max(dimensions.rows, dimensions.cols)) return null;
    // Iteration visits sparse slots too, unlike Array.every, so malformed paths cannot match.
    for (const cell of cells) if (!isCell(cell, dimensions)) return null;
    const line = getLine(cells[0], cells[cells.length - 1], dimensions);
    if (line.length !== cells.length || !line.every((cell, index) =>
      cell.row === cells[index].row && cell.col === cells[index].col)) return null;
    for (const entry of [...puzzle.words, ...(Array.isArray(puzzle.bonusWords) ? puzzle.bonusWords : [])]) {
      if (!entry || typeof entry.word !== 'string' || entry.word.length !== cells.length ||
        !/^[A-Z]+$/.test(entry.word) || !Array.isArray(entry.cells) || entry.cells.length !== cells.length) continue;
      let forward = true;
      let reverse = true;
      for (let index = 0; index < cells.length; index += 1) {
        const cell = entry.cells[index];
        if (!isCell(cell, dimensions)) {
          forward = false;
          reverse = false;
          break;
        }
        const selected = cells[index];
        const reversed = cells[cells.length - index - 1];
        if (cell.row !== selected.row || cell.col !== selected.col) forward = false;
        if (cell.row !== reversed.row || cell.col !== reversed.col) reverse = false;
      }
      if (forward || reverse) return entry.word;
    }
    return null;
  }

  return Object.freeze({ CATALOG_GENERATION, validateSeed, validateManifest, profileFor, normalizeTrapRange, getDimensions, getLine, getDragLine, matchSelection });
});
