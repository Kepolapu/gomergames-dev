(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.WordSearchJourney = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const VERSION = 5;
  const RESET_EPOCH = 'replacement-v1';
  // Kept only to read the retired shared meter in existing v4 saves.
  const LEGACY_CHEST_GOAL = 100;
  const LEGACY_BONUS_POINTS = 25;
  const GEMS_PER_COMPLETION = Object.freeze({ Easy: 30, Medium: 40, Hard: 50 });
  const GEMS_PER_CHEST = 100;
  const CATEGORY_REQUIREMENT = 4;
  const CATEGORY_COST = Object.freeze({ Easy: 100, Medium: 150, Hard: 200 });
  const DIFFICULTIES = Object.freeze(['Easy', 'Medium', 'Hard']);
  const FIRST_CATEGORY = 'farm-animals';
  const EARNED_PRIORITY = Object.freeze(['wild-animals', 'space']);
  const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
  const record = value => value && typeof value === 'object' && !Array.isArray(value);
  const validID = value => typeof value === 'string' && value.length > 0 && value.length <= 180 &&
    !['__proto__', 'constructor', 'prototype'].includes(value);
  const integer = value => Number.isSafeInteger(value) && value >= 0 ? value : 0;
  const wordList = value => Array.isArray(value) ? [...new Set(value.filter(word =>
    typeof word === 'string' && /^[A-Z]{1,40}$/.test(word)))] : [];
  const difficultyOf = value => DIFFICULTIES.includes(value) ? value : 'Easy';

  function createState() {
    return { version: VERSION, resetEpoch: RESET_EPOCH, revision: 0, maps: {}, activeDifficulty: 'Easy',
      chest: { points: 0 }, wallet: { gems: 0, awardedMapIds: [] } };
  }

  // A save written by a later release. This release must never overwrite it.
  function isNewer(raw) {
    return !!record(raw) && Number.isSafeInteger(raw.version) && raw.version > VERSION;
  }

  const KNOWN = Object.freeze({
    state: ['version', 'resetEpoch', 'revision', 'maps', 'activeDifficulty', 'chest', 'wallet', 'progression'],
    chest: ['points'],
    wallet: ['gems', 'jade', 'awardedMapIds'],
    map: ['signature', 'difficulty', 'words', 'bonusWords', 'openedAt', 'updatedRevision',
      'wordCount', 'bonusCount', 'complete', 'chestOpened']
  });
  // Fields added by a later v4 release are carried through unchanged, so an
  // older open tab can never erase them by rewriting the whole save.
  function keepUnknown(target, raw, known) {
    for (const [key, value] of Object.entries(raw)) {
      if (known.includes(key) || !validID(key) || value === undefined || typeof value === 'function') continue;
      try { target[key] = JSON.parse(JSON.stringify(value)); } catch { /* Not storable; drop it. */ }
    }
  }

  function normalizeProgression(raw) {
    if (!record(raw) || raw.version !== 1) return JSON.parse(JSON.stringify(raw));
    const result = { version: 1, tracks: {} };
    keepUnknown(result, raw, ['version', 'tracks']);
    for (const difficulty of DIFFICULTIES) {
      const source = raw.tracks?.[difficulty];
      if (!record(source)) continue;
      const ids = key => Array.isArray(source[key]) ? [...new Set(source[key].filter(validID))] : [];
      result.tracks[difficulty] = { unlockedCategoryIds: ids('unlockedCategoryIds'),
        completedMapIds: ids('completedMapIds'), earnedUnlocks: integer(source.earnedUnlocks) };
      keepUnknown(result.tracks[difficulty], source, ['unlockedCategoryIds', 'completedMapIds', 'earnedUnlocks']);
    }
    if (record(raw.tracks)) keepUnknown(result.tracks, raw.tracks, DIFFICULTIES);
    return result;
  }

  // Old campaigns are never imported, including their claims or unlocks.
  function normalizeState(raw) {
    const state = createState();
    if (!record(raw) || raw.version !== VERSION || raw.resetEpoch !== RESET_EPOCH) return state;
    keepUnknown(state, raw, KNOWN.state);
    if (raw.progression !== undefined) {
      try { state.progression = normalizeProgression(raw.progression); } catch { /* Not storable. */ }
    }
    if (record(raw.chest)) keepUnknown(state.chest, raw.chest, KNOWN.chest);
    if (record(raw.wallet)) keepUnknown(state.wallet, raw.wallet, KNOWN.wallet);
    state.revision = integer(raw.revision);
    state.activeDifficulty = difficultyOf(raw.activeDifficulty);
    const points = record(raw.chest) && Number.isFinite(raw.chest.points) ? raw.chest.points : 0;
    // Preserve the legacy wire field for save compatibility; it never funds a
    // map's chest. Each map's own bonus discoveries now determine its progress.
    state.chest.points = Math.max(0, Math.min(LEGACY_CHEST_GOAL,
      Math.floor(points / LEGACY_BONUS_POINTS) * LEGACY_BONUS_POINTS));
    // Read v4 saves written before the currency received its generic name.
    // Keep the same save generation and storage key so existing balances survive.
    state.wallet.gems = record(raw.wallet) ?
      integer(raw.wallet.gems === undefined ? raw.wallet.jade : raw.wallet.gems) : 0;
    if (record(raw.maps)) for (const [id, value] of Object.entries(raw.maps)) {
      if (!/^WS2_[A-Za-z_]+_(Easy|Medium|Hard)_\d{6}$/.test(id) || !validID(id) || !record(value) || typeof value.signature !== 'string') continue;
      const words = wordList(value.words), wordCount = integer(value.wordCount);
      state.maps[id] = {
        signature: value.signature, difficulty: difficultyOf(value.difficulty), words,
        bonusWords: wordList(value.bonusWords), openedAt: integer(value.openedAt),
        updatedRevision: integer(value.updatedRevision), wordCount,
        bonusCount: integer(value.bonusCount) || 3, chestOpened: value.chestOpened === true,
        complete: value.complete === true && (!wordCount || words.length >= wordCount)
      };
      keepUnknown(state.maps[id], value, KNOWN.map);
    }
    // Existing v4 completions are claimed without retroactive gems. The ID
    // remains claimed even if that seed's board changes and its map resets.
    const claimed = record(raw.wallet) && Array.isArray(raw.wallet.awardedMapIds) ?
      raw.wallet.awardedMapIds.filter(id => /^WS2_[A-Za-z_]+_(Easy|Medium|Hard)_\d{6}$/.test(id)) : [];
    state.wallet.awardedMapIds = [...new Set([...claimed, ...Object.entries(state.maps)
      .filter(([, map]) => map.complete).map(([id]) => id)])];
    return state;
  }

  function point(cell) {
    return Array.isArray(cell) ? cell.slice(0, 2) : [cell?.row, cell?.col];
  }

  function signature(seed) {
    const answers = entries => (entries || []).map(entry => [entry.word,
      point(entry.start || entry.cells?.[0]), point(entry.end || entry.cells?.[entry.cells.length - 1])]);
    return JSON.stringify([seed.version, seed.id, seed.rows, seed.cols,
      (seed.grid || []).map(row => Array.isArray(row) ? row.join('') : row),
      answers(seed.words), answers(seed.bonusWords)]);
  }

  function ensureMap(state, seed) {
    if (!validID(seed?.id)) throw new Error('A saved map requires a valid seed ID.');
    const key = signature(seed);
    let map = own(state.maps, seed.id) ? state.maps[seed.id] : null;
    if (!map || map.signature !== key) {
      map = { signature: key, difficulty: difficultyOf(seed.difficulty), words: [], bonusWords: [],
        openedAt: 0, updatedRevision: state.revision, complete: false,
        chestOpened: map?.chestOpened === true,
        wordCount: seed.words.length, bonusCount: seed.bonusWords.length };
      state.maps[seed.id] = map;
    }
    map.words = map.words.filter(word => seed.words.some(entry => entry.word === word));
    map.bonusWords = map.bonusWords.filter(word => seed.bonusWords.some(entry => entry.word === word));
    map.wordCount = seed.words.length;
    map.bonusCount = seed.bonusWords.length;
    map.difficulty = difficultyOf(seed.difficulty);
    map.complete = seed.words.length > 0 && map.words.length === seed.words.length;
    return map;
  }

  function touch(state, map) {
    state.revision += 1;
    if (map) map.updatedRevision = state.revision;
  }

  function visit(state, seed, now = Date.now()) {
    const map = ensureMap(state, seed);
    // Preserve ordering even when visits share one millisecond or the clock moves back.
    const lastOpened = Math.max(0, ...Object.values(state.maps).map(value => value.openedAt));
    map.openedAt = Math.max(integer(now), lastOpened + 1);
    state.activeDifficulty = difficultyOf(seed.difficulty);
    touch(state, map);
    return map;
  }

  function setDifficulty(state, difficulty) {
    if (!DIFFICULTIES.includes(difficulty) || state.activeDifficulty === difficulty) return false;
    state.activeDifficulty = difficulty;
    touch(state);
    return true;
  }

  function discover(state, seed, word, isBonus = false) {
    const answers = isBonus ? seed.bonusWords : seed.words;
    if (!answers.some(entry => entry.word === word)) {
      return { isNew: false, awarded: 0, gemsAwarded: 0, completedNow: false, map: state.maps[seed.id] || null };
    }
    const map = ensureMap(state, seed), completeBefore = map.complete;
    const destination = isBonus ? map.bonusWords : map.words;
    if (destination.includes(word)) return { isNew: false, awarded: 0, gemsAwarded: 0, completedNow: false, map };
    destination.push(word);
    const awarded = isBonus ? 1 : 0;
    map.complete = seed.words.length > 0 && map.words.length === seed.words.length;
    let gemsAwarded = 0;
    if (!completeBefore && map.complete && !state.wallet.awardedMapIds.includes(seed.id)) {
      state.wallet.awardedMapIds.push(seed.id);
      gemsAwarded = Math.min(GEMS_PER_COMPLETION[difficultyOf(seed.difficulty)],
        Number.MAX_SAFE_INTEGER - state.wallet.gems);
      state.wallet.gems += gemsAwarded;
    }
    touch(state, map);
    return { isNew: true, awarded, gemsAwarded, completedNow: !completeBefore && map.complete, map };
  }

  function chestProgress(state, seed) {
    const total = Array.isArray(seed?.bonusWords) ? seed.bonusWords.length : 0;
    const map = validID(seed?.id) && own(state.maps, seed.id) ? state.maps[seed.id] : null;
    const current = map?.signature === signature(seed || {}) ? map : null;
    const words = new Set(current?.bonusWords || []);
    const found = total ? seed.bonusWords.filter(entry => words.has(entry.word)).length : 0;
    // A changed board can reset discoveries, but never reissue its chest reward.
    const opened = map?.chestOpened === true;
    return { found, total, ready: !opened && total > 0 && found === total, opened };
  }

  function openChest(state, seed) {
    if (!chestProgress(state, seed).ready) return false;
    const map = ensureMap(state, seed);
    map.chestOpened = true;
    state.wallet.gems = Math.min(Number.MAX_SAFE_INTEGER, state.wallet.gems + GEMS_PER_CHEST);
    touch(state, map);
    return true;
  }

  function resumeId(state, library) {
    const available = new Set((library || []).map(entry => entry.id));
    return Object.entries(state.maps).filter(([id, map]) => available.has(id) && !map.complete)
      .sort((a, b) => b[1].openedAt - a[1].openedAt || a[0].localeCompare(b[0]))[0]?.[0] || '';
  }

  const categoryID = value => String(value || 'Puzzles').normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'puzzles';
  function seedCategoryID(id, fallback = '') {
    const prefix = typeof id === 'string' && /^WS2_(.*?)_(Easy|Medium|Hard)_\d+$/.exec(id)?.[1];
    return categoryID(prefix || fallback);
  }
  function completionDifficulty(state, id) {
    return DIFFICULTIES.includes(state.maps?.[id]?.difficulty) ? state.maps[id].difficulty
      : /_(Easy|Medium|Hard)_\d+$/.exec(id)?.[1] || '';
  }
  function historicalCompletions(state, difficulty) {
    const completed = new Set((state.wallet?.awardedMapIds || []).filter(validID));
    for (const [id, map] of Object.entries(state.maps || {})) if (map.complete && validID(id)) completed.add(id);
    return [...completed].filter(id => completionDifficulty(state, id) === difficulty).sort();
  }

  // Baseline contains only this campaign's completions and its opening access.
  function progressionBaseline(state) {
    const tracks = {};
    for (const difficulty of DIFFICULTIES) {
      const completedMapIds = historicalCompletions(state, difficulty);
      const unlockedCategoryIds = [FIRST_CATEGORY];
      tracks[difficulty] = { unlockedCategoryIds, completedMapIds,
        earnedUnlocks: Math.floor(completedMapIds.length / CATEGORY_REQUIREMENT) };
    }
    return { version: 1, tracks };
  }

  function openingCategoryID(collection, difficulty) {
    const categories = collection?.tracks?.[difficulty] || [];
    return categories.some(category => category.id === FIRST_CATEGORY) ? FIRST_CATEGORY : categories[0]?.id;
  }

  function initializeProgression(state, collection) {
    if (state.progression !== undefined && (!record(state.progression) || state.progression.version !== 1)) {
      throw new Error('This category progression version cannot be changed.');
    }
    const before = JSON.stringify(state.progression);
    const missingTracks = DIFFICULTIES.filter(difficulty => !record(state.progression?.tracks?.[difficulty]));
    const baseline = progressionBaseline(state);
    state.progression = state.progression === undefined ? baseline : normalizeProgression(state.progression);
    for (const difficulty of DIFFICULTIES) {
      const selected = state.progression.tracks[difficulty] ||= baseline.tracks[difficulty];
      const first = openingCategoryID(collection, difficulty);
      if (missingTracks.includes(difficulty) && first && !selected.unlockedCategoryIds.includes(first)) selected.unlockedCategoryIds.push(first);
    }
    const changed = before !== JSON.stringify(state.progression);
    if (changed) touch(state);
    return changed;
  }

  function catalog(library, config) {
    const entries = (Array.isArray(library) ? library : []).filter(entry => validID(entry?.id) && DIFFICULTIES.includes(entry.difficulty));
    const byID = new Map(entries.map(entry => [entry.id, entry]));
    const configured = [1, 2].includes(config?.version) && DIFFICULTIES.some(difficulty =>
      Array.isArray(config.tracks?.[difficulty]) && config.tracks[difficulty].length > 0);
    const tracks = Object.fromEntries(DIFFICULTIES.map(difficulty => [difficulty, []]));
    const assignedIDs = new Set();
    const round = (input, difficulty) => {
      const id = typeof input === 'string' ? input : input?.id;
      if (!validID(id) || assignedIDs.has(id)) return null;
      const entry = byID.get(id), available = !!entry && entry.difficulty === difficulty;
      assignedIDs.add(id);
      return { id, title: typeof input?.title === 'string' ? input.title : entry?.title || id,
        available, difficulty };
    };
    for (const difficulty of DIFFICULTIES) {
      const groups = new Map(), nameIDs = new Map();
      for (const category of configured && Array.isArray(config.tracks?.[difficulty]) ? config.tracks[difficulty] : []) {
        if (!record(category) || !validID(category.id) || groups.has(category.id)) continue;
        const group = { id: category.id, name: category.name || category.id, rounds: [] };
        groups.set(group.id, group); nameIDs.set(categoryID(group.name), group.id);
        for (const input of Array.isArray(category.rounds) ? category.rounds : []) {
          const item = round(input, difficulty); if (item) group.rounds.push(item);
        }
      }
      // Retain the configured round sequence and append newly published IDs in
      // stable order. New manifest categories participate without a config edit.
      for (const entry of entries.filter(item => item.difficulty === difficulty).sort((a, b) => a.id.localeCompare(b.id))) {
        if (assignedIDs.has(entry.id)) continue;
        const inferred = validID(entry.categoryId) ? entry.categoryId : seedCategoryID(entry.id, entry.category);
        const id = groups.has(inferred) ? inferred : nameIDs.get(categoryID(entry.category)) || inferred;
        if (!groups.has(id)) groups.set(id, { id, name: entry.category || id, rounds: [] });
        const item = round(entry, difficulty); if (item) groups.get(id).rounds.push(item);
      }
      tracks[difficulty] = [...groups.values()].map(category => ({ ...category,
        available: category.rounds.some(item => item.available),
        availableCount: category.rounds.filter(item => item.available).length }));
    }
    return { configured, tracks, assignedIds: [...assignedIDs] };
  }

  function progressionTrack(state, difficulty) {
    return state.progression?.version === 1 && record(state.progression.tracks?.[difficulty])
      ? state.progression.tracks[difficulty] : progressionBaseline(state).tracks[difficulty];
  }

  function advanceProgression(state, collection, difficulty, random = Math.random) {
    if (!DIFFICULTIES.includes(difficulty)) return { changed: false, unlocked: [], reason: 'invalid-difficulty' };
    const initialized = initializeProgression(state, collection), selected = state.progression.tracks[difficulty];
    const before = JSON.stringify(selected);
    selected.completedMapIds = [...new Set([...selected.completedMapIds, ...historicalCompletions(state, difficulty)])].sort();
    const due = Math.floor(selected.completedMapIds.length / CATEGORY_REQUIREMENT), unlocked = [];
    while (selected.earnedUnlocks < due) {
      const candidates = (collection?.tracks?.[difficulty] || []).filter(category =>
        category.available && !selected.unlockedCategoryIds.includes(category.id));
      if (!candidates.length) break;
      let choice = EARNED_PRIORITY.map(id => candidates.find(category => category.id === id)).find(Boolean);
      if (!choice) {
        const value = Number(random());
        if (!Number.isFinite(value) || value < 0 || value >= 1) throw new Error('Category selection needs a random number from 0 up to 1.');
        choice = candidates[Math.floor(value * candidates.length)];
      }
      selected.unlockedCategoryIds.push(choice.id); selected.earnedUnlocks++;
      unlocked.push({ ...choice });
    }
    const changed = before !== JSON.stringify(selected);
    if (changed) touch(state);
    return { changed: initialized || changed, unlocked, completedCount: selected.completedMapIds.length,
      progress: selected.completedMapIds.length % CATEGORY_REQUIREMENT, requirement: CATEGORY_REQUIREMENT };
  }

  function purchaseCategory(state, collection, difficulty, id) {
    const cost = CATEGORY_COST[difficulty];
    const failure = reason => ({ purchased: false, changed: false, reason, cost: cost || 0, category: null });
    if (!DIFFICULTIES.includes(difficulty)) return failure('invalid-difficulty');
    const category = collection?.tracks?.[difficulty]?.find(item => item.id === id);
    if (!category || !category.available) return failure('unavailable');
    if (!collection.configured || progressionTrack(state, difficulty).unlockedCategoryIds.includes(id) ||
        (!record(state.progression?.tracks?.[difficulty]) && id === openingCategoryID(collection, difficulty))) return failure('already-unlocked');
    if (state.wallet.gems < cost) return failure('insufficient-gems');
    initializeProgression(state, collection);
    state.wallet.gems -= cost;
    state.progression.tracks[difficulty].unlockedCategoryIds.push(id);
    touch(state);
    return { purchased: true, changed: true, reason: '', cost, category: { ...category } };
  }

  function chooseContinue(state, categories, currentId) {
    const available = categories.filter(category => category.unlocked && category.available);
    const roundCategory = id => available.find(category => category.rounds.some(round => round.id === id));
    let current = roundCategory(currentId);
    if (!current) {
      const last = available.flatMap(category => category.rounds).filter(round => state.maps[round.id]?.openedAt > 0)
        .sort((a, b) => state.maps[b.id].openedAt - state.maps[a.id].openedAt || a.id.localeCompare(b.id))[0];
      current = last && roundCategory(last.id);
    }
    const unfinished = category => category.rounds.filter(round => round.available && round.unlocked && !round.complete);
    const resumable = categories => categories.flatMap(unfinished).filter(round => state.maps[round.id]?.openedAt > 0)
      .sort((a, b) => state.maps[b.id].openedAt - state.maps[a.id].openedAt || a.id.localeCompare(b.id))[0]?.id || '';
    if (current) {
      const id = resumable([current]) || unfinished(current)[0]?.id;
      if (id) return id;
    }
    const others = available.filter(category => category !== current);
    return resumable(others) || others.flatMap(unfinished)[0]?.id || '';
  }

  function track(state, collection, difficulty) {
    const selected = difficultyOf(difficulty), source = collection?.tracks?.[selected] || [];
    const progression = progressionTrack(state, selected);
    const doneIDs = new Set([...progression.completedMapIds, ...historicalCompletions(state, selected)]);
    const completedCount = doneIDs.size, progress = completedCount % CATEGORY_REQUIREMENT;
    const done = id => doneIDs.has(id);
    const order = new Map(progression.unlockedCategoryIds.map((id, index) => [id, index]));
    // Small development catalogs may choose a different stable ID for their
    // opening category. Their first category remains usable before migration.
    const first = openingCategoryID(collection, selected);
    if (!record(state.progression?.tracks?.[selected]) && first && !order.has(first)) order.set(first, order.size);
    const categories = source.map((category, sourceIndex) => {
      const unlocked = !collection.configured || order.has(category.id);
      const availableRounds = category.rounds.filter(item => item.available);
      const frontierId = unlocked ? availableRounds.find(item => !done(item.id))?.id || '' : '';
      return { ...category, sourceIndex, unlocked, available: availableRounds.length > 0,
        availableCount: availableRounds.length, progress: unlocked ? CATEGORY_REQUIREMENT : progress,
        requirement: CATEGORY_REQUIREMENT, cost: CATEGORY_COST[selected], frontierId,
        completedCount: category.rounds.filter(item => state.maps[item.id]?.complete === true).length,
        rounds: category.rounds.map((item, roundIndex) => {
          const map = state.maps[item.id];
          return { ...item, number: roundIndex + 1, complete: map?.complete === true,
            bonusComplete: !!map && map.bonusWords.length >= (map.bonusCount || 3),
            frontier: item.id === frontierId,
            unlocked: item.available && unlocked && (!collection.configured || done(item.id) || !!map || item.id === frontierId) };
        }) };
    }).sort((a, b) => Number(b.unlocked) - Number(a.unlocked) ||
      (a.unlocked ? (order.get(a.id) ?? a.sourceIndex) - (order.get(b.id) ?? b.sourceIndex) : a.sourceIndex - b.sourceIndex));
    for (const category of categories) {
      category.nextId = chooseContinue(state, [category], '');
      delete category.sourceIndex;
    }
    const nextId = chooseContinue(state, categories, '');
    const playable = categories.flatMap(category => category.rounds).filter(item => item.available);
    return { difficulty: selected, categories, nextId, completedCount, progress,
      requirement: CATEGORY_REQUIREMENT, earnedUnlocks: integer(progression.earnedUnlocks),
      complete: playable.length > 0 && playable.every(item => item.complete) };
  }

  function continueId(state, collection, difficulty, currentId = '') {
    return chooseContinue(state, track(state, collection, difficulty).categories, currentId);
  }

  function resetCampaign(raw) {
    const state = createState();
    // Retain only the game's existing numeric balance until a separate balance
    // deletion is approved. No discoveries, purchases, claims or journal survive.
    if (record(raw) && raw.version === 4 && record(raw.wallet)) {
      state.wallet.gems = integer(raw.wallet.gems === undefined ? raw.wallet.jade : raw.wallet.gems);
    }
    return state;
  }

  return Object.freeze({ VERSION, RESET_EPOCH, resetCampaign, GEMS_PER_COMPLETION, GEMS_PER_CHEST,
    CATEGORY_REQUIREMENT, CATEGORY_COST, DIFFICULTIES,
    createState, isNewer, normalizeState, signature, visit, setDifficulty, discover,
    chestProgress, openChest, resumeId, catalog, track, progressionBaseline,
    initializeProgression, advanceProgression, purchaseCategory, continueId });
});
