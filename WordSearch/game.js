/* Saved puzzle files are the source of truth. Nothing generates a board here. */
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const Engine = window.WordSearchEngine;
  const Journey = window.WordSearchJourney;
  const GUEST_KEY = 'wordSearch.v5';
  let storageKey = GUEST_KEY, accountUid = '', saveEpoch = 0, activeStore = null;
  let cloudController = null, cloudStatus = '', cloudReady = true, cloudDetail = null, switchingSave = false;
  let cloudStatusTimer = 0, displayedCloudStatus = '';
  let latestAccount = { status: 'checking' }, accountSwitch = Promise.resolve();
  // Capture the previously displayed account before account checks clear a
  // deleted/signed-out identity. Only this one legacy save may seed migration.
  const HOME_BACKGROUND = 'backgrounds/home-sky-portrait-v1.webp';
  const COLORS = ['#cdddba', '#f1d59b', '#c9dce8', '#e7c9b9', '#d8cbe3', '#c5dfd3'];
  const WORD_TRANSITION_MS = 1040, WORD_BURST_MS = 180;
  const wordTransitions = new Map();
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  let library = [], puzzle = null, found = new Set(), foundBonus = new Set();
  let selected = [], anchor = null, pointer = null, hint = null;
  let activeCell = { row: 0, col: 0 }, loadNumber = 0, hintTimer, lastHint = '', miss = [], missTimer, missStarted = 0;
  let storageOK = true, databaseReady = false;
  let saved = Journey.createState(), catalog = null, saveInitialized = false;
  let screen = 'home', selectionDifficulty = 'Easy', completionOpen = false, unlockedCategory = '', gemsAwarded = 0;
  let unlockedCategoryId = '', categoryPurchase = null, purchasingCategory = false;
  let saveQueue = Promise.resolve(), chestOpening = false, feedbackTimer;
  let accountStatus = 'checking', saveMode = 'device';
  let deletingLocalData = false, localResetGuard = false, localConflictGuard = false;
  let fitFrame = 0;
  // Player-facing text. Reword freely; keep the keys.
  const STRINGS = Object.freeze({
    account: Object.freeze({
      checking: ['Checking account', 'progress stays on this device'],
      guest: ['Playing as guest', 'progress stays on this device'],
      setup: ['Finish account setup', 'progress stays on this device'],
      verified: ['Signed in', 'progress stays on this device'],
      deleting: ['Account deletion underway', 'progress stays on this device'],
      deleted: ['Account deleted', 'progress stays on this device'],
      unavailable: ['Account check unavailable', 'progress stays on this device'],
    }),
    save: Object.freeze({
      status: 'progress isn\'t being saved',
      notice: 'Progress is only kept while this page stays open. It will be lost when you close or reload.',
      newerStatus: 'reload to keep saving',
      newerNotice: 'A newer version of Word Search saved your progress. Reload the page to keep saving.',
    }),
    errors: Object.freeze({
      offline: 'Word Search couldn\'t connect. Check your internet connection, then tap Retry.',
      unavailable: 'Word Search didn\'t get a reply. Tap Retry in a moment.',
      missing: 'This round couldn\'t be found. Tap Retry, or choose another round from Home.',
      damaged: 'This round\'s puzzle file is damaged. Choose another round from Home.',
      notListed: 'That round isn\'t available. Choose another round from Home.',
      library: 'The list of puzzles couldn\'t be loaded. Tap Retry in a moment.',
      savedBalance: 'Your saved gem balance couldn\'t be read. Close other Word Search tabs, then tap Retry.',
      empty: 'No puzzles are available yet. Please check back soon.',
      engine: 'Word Search didn\'t load completely. Refresh the page to try again.',
      localHint: 'To play locally, serve this folder over HTTP.',
    }),
  });

  window.addEventListener('wordsearch-account-state', event => {
    if (localResetGuard || localConflictGuard) return;
    const status = event.detail?.status;
    if (!Object.hasOwn(STRINGS.account, status)) return;
    accountStatus = status;
    latestAccount = event.detail;
    renderAccountStatus();
    if (saveInitialized && cloudEnabled()) void selectAccount(event.detail);
  });
  const cloudEnabled = () => window.WordSearchCloudConfig?.enabled === true && !!window.WordSearchCloud;
  const cloudBlocked = () => localResetGuard || localConflictGuard || cloudEnabled() && (switchingSave || !!accountUid && !cloudReady);
  const currentStore = () => activeStore || window.WordSearchStore;
  const cloudLabels = {
    checking: 'Checking cloud progress…', choice: 'Choose which progress to keep',
    syncing: 'Saving to cloud…', synced: 'Saved to cloud',
    offline: 'Saved on this device · waiting to sync', error: 'Cloud sync needs attention',
    stopped: 'Cloud saving paused',
    local: 'Saved on this device',
  };
  function compareCloudProgress(states) {
    if (!states?.local || !states?.cloud) return {};
    // A save is further along only if it includes every discovery in the other.
    // Balances can be spent/reset, and revisions also advance on navigation.
    const discoveries = state => {
      const found = new Set();
      for (const [id, map] of Object.entries(state.maps || {})) {
        const add = (kind, word = '') => found.add(JSON.stringify([id, map.signature, kind, word]));
        for (const word of map.words || []) add('word', word);
        for (const word of map.bonusWords || []) add('bonus', word);
        if (map.complete) add('complete');
        if (map.chestOpened) add('chestOpened');
      }
      return found;
    };
    const local = discoveries(states.local), cloud = discoveries(states.cloud);
    const localOnly = [...local].some(value => !cloud.has(value));
    const cloudOnly = [...cloud].some(value => !local.has(value));
    if (localOnly && !cloudOnly) return { local: 'further', cloud: 'less' };
    if (cloudOnly && !localOnly) return { local: 'less', cloud: 'further' };
    return { local: localOnly ? 'different' : 'same', cloud: cloudOnly ? 'different' : 'same' };
  }
  function renderCloud() {
    const button = $('cloud-status');
    if (!button) return;
    button.hidden = !cloudEnabled() || !accountUid;
    $('settings-cloud-save').hidden = button.hidden;
    button.textContent = cloudLabels[cloudStatus] || 'Account progress';
    if (accountUid && !cloudReady && cloudStatus === 'offline') button.textContent = 'Connect to choose account progress';
    const statusKey = button.hidden ? '' : `${accountUid}:${cloudStatus}:${button.textContent}`;
    if (statusKey !== displayedCloudStatus) {
      displayedCloudStatus = statusKey;
      clearTimeout(cloudStatusTimer);
      button.classList.remove('is-faded');
      if (statusKey) cloudStatusTimer = setTimeout(() => button.classList.add('is-faded'), 3000);
    }
    const detail = cloudDetail || {};
    $('cloud-title').textContent = cloudStatus === 'synced' ? 'Cloud save is synced'
      : cloudStatus === 'checking' ? 'Checking cloud save'
      : cloudStatus === 'syncing' ? 'Syncing cloud save…' : 'Cloud save is not synced';
    $('cloud-description').textContent = detail.status === 'choice'
      ? 'Choose one complete save. The other save will be permanently replaced. There is no undo.'
      : cloudStatus === 'synced' ? 'Your account progress is saved in the cloud.'
      : cloudStatus === 'offline' ? 'Your cloud save is not confirmed yet. Your progress stays on this device, and we will retry automatically while the game is open and connected.'
      : cloudStatus === 'local' ? 'Your latest progress is saved on this device. Tap Save to cloud now to back it up.'
      : 'Your local progress is kept while we connect to your account.';
    $('cloud-message').textContent = detail.error?.localStorage
      ? detail.error.newerSave ? STRINGS.save.newerNotice : 'Account progress cannot be saved on this device. Allow site storage, then retry.'
      : detail.error?.code === 'cloud/profile-required'
      ? 'Open your account and finish setup, then try again.'
      : detail.status === 'error' ? 'We could not sync this save. You can keep playing on this device or retry.'
      : detail.guestImportError ? 'Guest progress uses an unsupported format and has been kept unchanged on this device.' : '';
    $('cloud-warning').hidden = detail.status !== 'choice';
    const comparison = detail.status === 'choice' ? compareCloudProgress(detail.states) : {};
    const progressLabels = { further: 'Further progress', less: 'Less progress', different: 'Different progress', same: 'Same words, rounds & chests' };
    for (const [name, id] of [['local', 'local'], ['cloud', 'remote']]) {
      const shown = detail.status === 'choice' && detail.choices?.includes(name);
      const option = $(`cloud-${id}`), progress = $(`cloud-${id}-progress`);
      option.hidden = !shown;
      option.classList.toggle('has-further-progress', shown && comparison[name] === 'further');
      option.classList.toggle('has-less-progress', shown && comparison[name] === 'less');
      progress.textContent = progressLabels[comparison[name]] || '';
      progress.hidden = !shown || !comparison[name];
      const summary = $(`cloud-${id}-summary`); summary.hidden = !shown;
      const value = detail.states?.[name];
      const maps = Object.values(value?.maps || {});
      const words = maps.reduce((total, map) => total + (map.words?.length || 0) + (map.bonusWords?.length || 0), 0);
      summary.textContent = value ? `${maps.filter(map => map.complete).length} rounds complete · ${words} words found · ${value.wallet?.gems || 0} gems · ${maps.filter(map => map.chestOpened).length} chests opened` : 'Start fresh';
    }
    $('cloud-retry').hidden = detail.status === 'choice' || cloudStatus === 'synced';
    $('cloud-retry').textContent = cloudStatus === 'local' ? 'Save to cloud now' : 'Try syncing again';
    if (puzzle) $('board').inert = completionOpen || cloudBlocked();
    if (catalog) renderHome();
    renderAccountStatus(); scheduleFit();
  }
  function openCloudDialog() {
    if (!cloudEnabled()) return;
    renderCloud();
    if (!$('cloud-dialog').open) $('cloud-dialog').showModal();
    placeBanners();
  }
  function repaintSave() {
    if (!catalog) return;
    applyProgress();
    if (puzzle) {
      if (found.size !== puzzle.words.length) { completionOpen = false; gemsAwarded = 0; unlockedCategory = ''; unlockedCategoryId = ''; }
      if (unlockedCategoryId && !Journey.track(saved, catalog, puzzle.difficulty).categories.some(category =>
        category.id === unlockedCategoryId && category.unlocked && category.available)) {
        unlockedCategory = ''; unlockedCategoryId = '';
      }
      renderProgress();
    }
    renderHome(); renderLibrary(); renderBonus(); renderGems();
  }
  function selectAccount(detail) {
    if (localResetGuard || localConflictGuard || !cloudEnabled()) return Promise.resolve();
    if (detail.status === 'checking' && (!detail.uid || detail.uid === accountUid)) return Promise.resolve();
    const uid = ['verified', 'unavailable', 'checking'].includes(detail.status) ? detail.uid || '' : '';
    if (uid === accountUid) {
      if (uid && detail.status === 'verified') void cloudController?.sync();
      if (!uid && !switchingSave) {
        const epoch = saveEpoch;
        accountSwitch = saveQueue.then(() => epoch === saveEpoch && window.WordSearchStore.detach?.())
          .catch(error => { if (epoch === saveEpoch) setSaveMode(error?.newerSave ? 'newer' : 'failed'); });
      }
      return accountSwitch;
    }
    const epoch = ++saveEpoch;
    ++loadNumber; cancelSelection(); cloudController?.stop(); cloudController = null;
    unlockedCategory = ''; unlockedCategoryId = '';
    if ($('category-unlock-dialog').open) $('category-unlock-dialog').close();
    // The retired load no longer owns its finally block. Clear its busy state
    // here so changing accounts cannot leave an abandoned loading indicator.
    $('game-layout').setAttribute('aria-busy', 'false');
    clearWordTransitions(); clearTimeout(feedbackTimer);
    chestOpening = false; $('bonus-feedback').classList.remove('is-visible'); $('chest-status').textContent = '';
    // Identity changes never swap the one device save. The old controller stops
    // synchronously, before a different account can start using the same store.
    if ($('cloud-dialog').open) $('cloud-dialog').close();
    accountUid = uid; cloudStatus = uid ? 'checking' : ''; cloudDetail = null;
    storageKey = GUEST_KEY;
    activeStore = window.WordSearchStore;
    cloudReady = false; switchingSave = true;
    renderCloud(); renderSaveNotice();
    const switchSave = async () => {
      await saveQueue;
      if (epoch !== saveEpoch) return;
      cloudReady = !uid; switchingSave = false;
      if (!uid) {
        try { await window.WordSearchStore.detach?.(); }
        catch (error) { if (epoch === saveEpoch) setSaveMode(error?.newerSave ? 'newer' : 'failed'); }
        if (epoch !== saveEpoch) return;
        await refreshSave();
        if (epoch !== saveEpoch) return;
        repaintSave(); renderCloud(); return;
      }
      const controller = window.WordSearchCloud.create({
        Journey, uid, store: activeStore,
        transport: window.WordSearchAccount.transport(uid),
        allowSync: () => epoch === saveEpoch && latestAccount.status === 'verified' && latestAccount.uid === uid,
        onStatus: detail => {
          if (epoch !== saveEpoch) return;
          cloudStatus = detail.status; cloudReady = !!detail.ready; cloudDetail = detail;
          if (detail.error?.localConflict) { stopForLocalConflict(); return; }
          if (detail.error?.newerSave) setSaveMode('newer');
          else if (detail.ready) setSaveMode(window.WordSearchStore.mode === 'memory' ? 'memory' : 'device');
          renderCloud();
          if (detail.status === 'choice') openCloudDialog();
        },
        onChange: value => {
          if (epoch !== saveEpoch) return;
          saved = Journey.normalizeState(value); databaseReady = window.WordSearchStore.mode !== 'memory';
          repaintSave();
        },
      });
      cloudController = controller; activeStore = controller;
      renderCloud();
      try {
        const current = await controller.start();
        if (epoch !== saveEpoch) return;
        if (current?.state) saved = current.state;
        databaseReady = !!current?.exists;
        repaintSave(); renderCloud();
      } catch {
        if (epoch !== saveEpoch) return;
        cloudStatus = 'error'; cloudReady = true; renderCloud();
      }
    };
    // An obsolete account's network request must not delay a later switch.
    // The epoch guards every asynchronous read and callback instead.
    accountSwitch = switchSave();
    return accountSwitch;
  }
  function renderAccountStatus() {
    const [label, kept] = STRINGS.account[accountStatus];
    const saving = saveMode === 'device', newer = saveMode === 'newer';
    const cloudText = accountUid ? cloudLabels[cloudStatus] || 'account progress on this device' : kept;
    const text = `${label} · ${saving ? cloudText : newer ? STRINGS.save.newerStatus : STRINGS.save.status}`;
    const avatar = $('account-link');
    const avatarId = latestAccount.uid && ['verified', 'checking', 'unavailable'].includes(accountStatus)
      ? latestAccount.avatarId : 'default';
    window.GomerAvatars?.renderAvatar(avatar, avatarId);
    avatar.classList.toggle('is-signed-in', accountStatus === 'verified');
    avatar.setAttribute('aria-label', `${accountStatus === 'verified' ? 'Manage your Gomer Games account.'
      : 'Sign in or manage your Gomer Games account.'} ${saving
      ? accountUid ? cloudText : 'Word Search progress stays on this device.' : saveNoticeText()}`);
    avatar.title = text;
    scheduleFit();
  }
  // device: the last write reached IndexedDB or the localStorage copy.
  // memory: neither store accepts writes, so progress lasts only for this page.
  // failed: IndexedDB refused a write, so that change was not kept.
  // newer: a later release saved here; this page keeps playing but never writes over it.
  function setSaveMode(mode) {
    if (localConflictGuard) mode = 'conflict';
    if (saveMode === mode) return;
    saveMode = mode;
    renderAccountStatus(); renderSaveNotice();
  }
  function saveNoticeText() {
    if (saveMode === 'conflict') return 'Saving is paused: another tab saved different progress. Download the recovery copies before reloading.';
    if (saveMode === 'memory' && accountUid) {
      return 'This device cannot keep a local save. Changes not yet saved to cloud can be lost when you close or reload.';
    }
    return saveMode === 'device' ? '' : saveMode === 'newer' ? STRINGS.save.newerNotice : STRINGS.save.notice;
  }
  function renderSaveNotice() {
    const notice = $('save-notice'); if (!notice) return; // A cached older page has no notice.
    const text = saveNoticeText();
    if (notice.textContent !== text) notice.textContent = text;
    placeBanners();
  }

  function scheduleFit() {
    if (fitFrame) return;
    fitFrame = requestAnimationFrame(() => { fitFrame = 0; fitGameToViewport(); });
  }
  function fitGameToViewport() {
    const viewport = $('game-viewport'), app = document.querySelector('.app');
    const visible = window.visualViewport;
    const width = visible?.width || document.documentElement.clientWidth;
    const height = visible?.height || document.documentElement.clientHeight;
    viewport.style.width = `${width}px`; viewport.style.height = `${height}px`;
    viewport.style.left = `${visible?.offsetLeft || 0}px`;
    viewport.style.top = `${visible?.offsetTop || 0}px`;
    const padding = getComputedStyle(viewport);
    const left = parseFloat(padding.paddingLeft), top = parseFloat(padding.paddingTop);
    const availableWidth = Math.max(1, width - left - parseFloat(padding.paddingRight));
    const availableHeight = Math.max(1, height - top - parseFloat(padding.paddingBottom));
    const maxWidth = Math.min(560, availableWidth);
    const board = $('board'), boardPanel = document.querySelector('.board-panel');
    const wordPanel = document.querySelector('.word-panel');
    app.style.width = `${maxWidth}px`;
    boardPanel.style.width = `${maxWidth}px`;
    wordPanel.classList.remove('is-compact');

    // Spend the word panel's spare space before reducing the board.
    if (screen === 'game' && puzzle && app.offsetHeight > availableHeight) {
      wordPanel.classList.add('is-compact');
    }

    const boardStyle = getComputedStyle(board);
    const horizontalInset = parseFloat(boardStyle.paddingLeft) + parseFloat(boardStyle.paddingRight) +
      parseFloat(boardStyle.borderLeftWidth) + parseFloat(boardStyle.borderRightWidth);
    const verticalInset = parseFloat(boardStyle.paddingTop) + parseFloat(boardStyle.paddingBottom) +
      parseFloat(boardStyle.borderTopWidth) + parseFloat(boardStyle.borderBottomWidth);
    if (screen === 'game' && puzzle && app.offsetHeight > availableHeight) {
      const overhead = app.offsetHeight - board.offsetHeight;
      const target = (availableHeight - overhead - verticalInset) * puzzle.cols / puzzle.rows + horizontalInset;
      // The controls and words keep their own width when the board must narrow.
      boardPanel.style.width = `${Math.max(Math.min(240, maxWidth), Math.min(maxWidth, target))}px`;
    }
    // Only exceptionally short screens need a final scale of the complete interface.
    const scale = Math.min(1, availableWidth / app.offsetWidth, availableHeight / Math.max(1, app.offsetHeight));
    app.style.setProperty('--fit-scale', scale);
    app.style.left = `${left + availableWidth / 2}px`; app.style.top = `${top}px`;
    if (screen === 'game' && !$('completion').hidden) {
      const card = document.querySelector('.completion-card');
      const cardScale = Math.min(1, Math.max(1, board.clientWidth - 24) / card.offsetWidth,
        Math.max(1, board.clientHeight - 24) / card.offsetHeight);
      card.style.setProperty('--completion-scale', cardScale);
    }
  }
  // Returns true when this device has a copy (current or from a later release).
  function readLatestSave() {
    try {
      const raw = localStorage.getItem(storageKey);
      if (storageOK && raw) {
        const parsed = JSON.parse(raw);
        if (Journey.isNewer(parsed)) { setSaveMode('newer'); return true; }
        const incoming = Journey.normalizeState(parsed);
        if (incoming.revision >= saved.revision) saved = incoming;
        return true;
      }
    } catch { storageOK = false; }
    return false;
  }
  // The device copy was written by a later release, so this page must not replace it.
  function mirrorIsNewer() {
    try {
      const raw = localStorage.getItem(storageKey);
      return !!raw && Journey.isNewer(JSON.parse(raw));
    } catch { return false; }
  }
  function applyProgress() {
    if (!puzzle) return;
    const previous = saved.maps[puzzle.id];
    const current = previous?.signature === Journey.signature(puzzle) ? previous : null;
    found = new Set((current?.words || []).filter(word => puzzle.words.some(entry => entry.word === word)));
    foundBonus = new Set((current?.bonusWords || []).filter(word => puzzle.bonusWords.some(entry => entry.word === word)));
  }
  // The database transaction owns reward claims. localStorage is only a
  // revisioned display snapshot/notification, never the source of a new credit.
  function updateSave(change) {
    const epoch = saveEpoch;
    const commit = async () => {
      if (epoch !== saveEpoch || cloudBlocked()) {
        throw Object.assign(new Error('Choose a save before continuing.'), { saveFailure: true });
      }
      // Either storage copy can belong to a later release. Never let an older
      // IndexedDB record bypass the newer device copy's write barrier.
      if (saveMode === 'newer' || mirrorIsNewer()) {
        setSaveMode('newer');
        throw Object.assign(new Error('A newer version of the game saved this progress.'),
          { saveFailure: true, newerSave: true });
      }
      let outcome;
      const mutate = state => {
        if (catalog) Journey.initializeProgression(state, catalog);
        return change(state);
      };
      try {
        const store = currentStore();
        // A store script that never loaded is unavailable storage, not a failed write.
        if (!store) throw Object.assign(new Error('IndexedDB is unavailable.'), { safeToFallback: true });
        outcome = await store.update(mutate, saved);
        if (epoch !== saveEpoch) throw Object.assign(new Error('The active account changed.'), { saveFailure: true });
        databaseReady = window.WordSearchStore?.mode !== 'memory';
      } catch (error) {
        if (error?.localConflict) stopForLocalConflict();
        // Once IndexedDB has worked, a later failure is not a fallback: a change kept
        // only in the device copy would be undone by the next read of the database.
        if (epoch !== saveEpoch) throw Object.assign(error, { saveFailure: true });
        if (accountUid || !error?.safeToFallback || databaseReady) {
          // The change was not kept. Callers catch this so play and navigation continue.
          setSaveMode(error?.newerSave ? 'newer' : 'failed');
          if (error && typeof error === 'object') error.saveFailure = true;
          throw error;
        }
        if (mirrorIsNewer()) {
          setSaveMode('newer');
          throw Object.assign(new Error('A newer version of the game saved this progress.'), { saveFailure: true });
        }
        // Storage-disabled browsers can still play. Never retry a transaction
        // whose commit is uncertain, since that could award or open twice.
        const state = Journey.normalizeState(saved);
        outcome = { state, result: mutate(state) };
      }
      // The committed state is the authority, even if an earlier display was ahead of it.
      saved = outcome.state;
      renderGems();
      // The store owns the full snapshot and pending-upload journal. Never
      // overwrite it with the controller's canonical, gameplay-only UI copy.
      storageOK = !!window.WordSearchStore && window.WordSearchStore.mode !== 'memory';
      setSaveMode(storageOK ? 'device' : 'memory');
      return outcome.result;
    };
    const run = () => {
      if (!navigator.locks?.request) return commit();
      // Blocking site data also refuses the lock. With storage denied there is no
      // shared save for other tabs to race on, so save without it.
      let started = false;
      return navigator.locks.request(storageKey, () => { started = true; return commit(); })
        .catch(error => { if (started || error?.name !== 'SecurityError') throw error; return commit(); });
    };
    const pending = saveQueue.then(run, run);
    saveQueue = pending.catch(() => {});
    return pending;
  }
  // Navigation and other tabs' changes read the committed save; they never
  // write. Returns true when this device already has a save in IndexedDB.
  async function refreshSave() {
    const epoch = saveEpoch;
    await saveQueue;
    if (epoch !== saveEpoch) return false;
    if (mirrorIsNewer()) setSaveMode('newer');
    let exists = false;
    try {
      const current = await currentStore()?.read();
      if (epoch !== saveEpoch) return false;
      if (current?.localConflict) { stopForLocalConflict(); return false; }
      if (current?.newer) { setSaveMode('newer'); exists = true; }
      else if (current?.exists) {
        saved = current.state; databaseReady = window.WordSearchStore?.mode !== 'memory'; exists = true;
        setSaveMode(window.WordSearchStore?.mode === 'memory' ? 'memory' : 'device');
      }
      else exists = readLatestSave();
    } catch (error) {
      if (error?.localConflict) { stopForLocalConflict(); return false; }
      if (epoch !== saveEpoch) return false;
      // Unavailable IndexedDB: the device copy is the save. After IndexedDB has
      // worked, keep the committed state shown rather than an older device copy.
      exists = databaseReady || readLatestSave();
    }
    renderGems();
    return exists;
  }
  function announce(message) {
    $('toast').textContent = message;
  }
  // Retry repeats whatever failed: opening the game or opening a round.
  const bootRetry = () => boot();
  let retryAction = bootRetry;
  const developing = location.protocol === 'file:' || ['localhost', '127.0.0.1'].includes(location.hostname);
  function showError(kind, retry, error) {
    retryAction = retry;
    let message = STRINGS.errors[kind] || STRINGS.errors.unavailable;
    if (developing) {
      message += location.protocol === 'file:' ? ` ${STRINGS.errors.localHint}` : error?.message ? ` (${error.message})` : '';
    }
    $('load-error-text').textContent = message;
    $('load-error').hidden = false;
    placeBanners();
  }
  // A modal dialog makes the page behind it inert, so the error and save notice
  // move into an open dialog, under its heading.
  function placeBanners() {
    const error = $('load-error'), notice = $('save-notice');
    const dialog = [...document.querySelectorAll('dialog[open]')].at(-1);
    const anchor = dialog ? dialog.querySelector('.dialog-heading') : document.querySelector('.game-header');
    if (error.previousElementSibling !== anchor) anchor.after(error);
    if (notice && notice.previousElementSibling !== error) error.after(notice);
    scheduleFit();
  }
  const problem = (kind, detail) => Object.assign(new Error(detail || kind), { kind });
  async function readJSON(url, expectedHash) {
    let response;
    try { response = await fetch(url, { cache: 'no-cache' }); }
    catch { throw problem('offline'); }
    if (!response.ok) throw problem([404, 410].includes(response.status) ? 'missing' : 'unavailable', `HTTP ${response.status}`);
    try {
      const text = await response.text();
      if (expectedHash) {
        if (!globalThis.crypto?.subtle) throw problem('damaged', 'Puzzle integrity verification is unavailable.');
        const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
        const actual = [...new Uint8Array(bytes)].map(value => value.toString(16).padStart(2, '0')).join('');
        if (actual !== expectedHash) throw problem('damaged', 'Puzzle content does not match its immutable library identity.');
      }
      return JSON.parse(text);
    }
    catch (error) { if (error?.kind) throw error; throw problem('damaged', 'Not valid JSON'); }
  }
  function validateManifest(raw) { return Engine.validateManifest(raw); }
  function badge(parent, className, text, label) {
    const element = document.createElement('span');
    element.className = className; element.textContent = text;
    element.setAttribute('role', 'img'); element.setAttribute('aria-label', label); element.title = label;
    parent.append(element);
  }
  function renderLibrary() {
    if (!catalog) return;
    const list = $('library-list');
    const positions = new Map([...list.querySelectorAll('.category-rounds')].map(row => [row.dataset.category, row.scrollLeft]));
    list.replaceChildren();
    list.setAttribute('aria-labelledby', `difficulty-${selectionDifficulty.toLowerCase()}`);
    document.querySelectorAll('#difficulty-tabs [data-difficulty]').forEach(tab => {
      const active = tab.dataset.difficulty === selectionDifficulty;
      tab.setAttribute('aria-selected', String(active)); tab.tabIndex = active ? 0 : -1;
    });
    const track = Journey.track(saved, catalog, selectionDifficulty);
    $('selection-unlock-progress').textContent = track.categories.some(category => category.available && !category.unlocked)
      ? `${track.progress} / ${track.requirement} maps to unlock a category` : '';
    $('selection-gem-count').textContent = saved.wallet.gems.toLocaleString();
    let lockedHeading = false;
    for (const category of track.categories) {
      if (!category.available) continue;
      const section = document.createElement('section'); section.className = 'category-section';
      section.dataset.category = category.id;
      if (!category.unlocked) {
        if (!lockedHeading) {
          const label = document.createElement('p'); label.className = 'locked-categories-heading';
          label.textContent = 'Locked categories'; list.append(label); lockedHeading = true;
        }
        const purchase = document.createElement('button'); purchase.type = 'button'; purchase.className = 'category-purchase';
        purchase.setAttribute('aria-label', `Unlock ${category.name}`);
        purchase.setAttribute('aria-haspopup', 'dialog'); purchase.setAttribute('aria-controls', 'category-unlock-dialog');
        const name = document.createElement('span'); name.className = 'category-name'; name.textContent = category.name;
        purchase.append(name, lockIcon()); purchase.disabled = cloudBlocked();
        purchase.addEventListener('click', () => openCategoryPurchase(category.id));
        section.append(purchase); list.append(section); continue;
      }
      const heading = document.createElement('div'); heading.className = 'category-heading';
      const name = document.createElement('h3'); name.textContent = category.name; heading.append(name);
      const rounds = document.createElement('div'); rounds.className = 'category-rounds';
      rounds.dataset.category = category.id; rounds.dataset.frontier = category.frontierId || '';
      rounds.tabIndex = 0; rounds.setAttribute('role', 'group'); rounds.setAttribute('aria-label', `${category.name} rounds`);
      for (const round of category.rounds) {
        if (!round.available) continue;
        const entry = library.find(item => item.id === round.id);
        const button = document.createElement('button'); button.type = 'button';
        button.className = 'library-card' + (puzzle?.id === round.id ? ' current' : '') + (!round.unlocked ? ' locked' : '');
        button.disabled = !round.unlocked || cloudBlocked();
        button.dataset.seed = round.id;
        if (puzzle?.id === round.id) button.setAttribute('aria-current', 'true');
        const number = document.createElement('span'); number.className = 'card-round';
        number.textContent = `Round ${round.number}`;
        const marker = document.createElement('span'); marker.className = 'round-marker';
        if (!round.unlocked) marker.append(lockIcon());
        const badges = document.createElement('span'); badges.className = 'round-badges';
        if (round.complete) badge(badges, 'card-completed', '\u2713', 'Main words complete');
        if (round.bonusComplete) badge(badges, 'card-star', '\u2605', 'All bonus words found');
        marker.append(badges);
        const detail = document.createElement('span'); detail.className = 'card-meta';
        const map = saved.maps[round.id], wordCount = map?.wordCount || entry.wordCount;
        const words = Math.min(map?.words.length || 0, wordCount), bonus = Math.min(map?.bonusWords.length || 0, 3);
        detail.append(document.createTextNode(`Words ${words}/${wordCount}`), document.createElement('br'), document.createTextNode(`Bonus ${bonus}/3`));
        button.setAttribute('aria-label', `${category.name}, round ${round.number}, ${round.title}, ${words} of ${wordCount} words, ${bonus} of 3 bonus words${!round.unlocked ? ', locked' : ''}`);
        button.append(number, marker, detail);
        button.addEventListener('click', async () => {
          if (await loadPuzzle(round.id)) {
            $('library-dialog').close();
            focusCell(activeCell);
          }
        });
        rounds.append(button);
      }
      enableRoundDrag(rounds);
      section.append(heading, rounds); list.append(section);
      if (positions.has(category.id)) rounds.scrollLeft = positions.get(category.id);
    }
    if (!track.categories.length) {
      const empty = document.createElement('p'); empty.className = 'selection-empty';
      empty.textContent = 'More rounds are on their way.'; list.append(empty);
    }
  }
  function lockIcon() {
    const icon = document.createElement('img'); icon.className = 'lock-image';
    icon.src = 'assets/lock-gold-v1.png';
    icon.alt = ''; icon.width = 38; icon.height = 38; icon.draggable = false;
    return icon;
  }
  function snapRound(row, direction = 0) {
    const cards = [...row.querySelectorAll('.library-card')];
    if (!cards.length) return;
    const offsets = cards.map(card => card.getBoundingClientRect().left - row.getBoundingClientRect().left + row.scrollLeft - 3);
    let index = offsets.reduce((best, value, i) => Math.abs(value - row.scrollLeft) < Math.abs(offsets[best] - row.scrollLeft) ? i : best, 0);
    index = Math.max(0, Math.min(cards.length - 1, index + direction));
    row.scrollTo({ left: offsets[index], behavior: reducedMotion.matches ? 'auto' : 'smooth' });
  }
  function enableRoundDrag(row) {
    let drag = null, suppressClick = false, settleTimer;
    const settled = () => { clearTimeout(settleTimer); row.classList.remove('is-settling'); };
    row.addEventListener('scrollend', () => { if (!drag) settled(); });
    row.addEventListener('pointerdown', event => {
      if (row.classList.contains('is-settling')) { row.scrollLeft = row.scrollLeft; settled(); }
      if (event.pointerType !== 'mouse' || event.button !== 0) return;
      suppressClick = false; drag = { id: event.pointerId, x: event.clientX, left: row.scrollLeft, moved: false };
    });
    row.addEventListener('pointermove', event => {
      if (!drag || event.pointerId !== drag.id) return;
      const delta = event.clientX - drag.x;
      if (!drag.moved && Math.abs(delta) < 6) return;
      if (!drag.moved) { drag.moved = true; row.classList.add('is-dragging'); row.setPointerCapture(drag.id); }
      event.preventDefault(); row.scrollLeft = drag.left - delta;
    });
    const finish = event => {
      if (!drag || event.pointerId !== drag.id) return;
      const moved = drag.moved; drag = null;
      if (moved) row.classList.add('is-settling');
      row.classList.remove('is-dragging');
      // Keep native snapping off while the smooth scroll settles. Restoring it
      // first would jump to a marker immediately after releasing the mouse.
      if (moved) { suppressClick = true; snapRound(row); settleTimer = setTimeout(settled, 600); }
    };
    row.addEventListener('pointerup', finish); row.addEventListener('pointercancel', finish);
    row.addEventListener('lostpointercapture', finish);
    row.addEventListener('click', event => { if (suppressClick) { event.preventDefault(); event.stopPropagation(); suppressClick = false; } }, true);
    row.addEventListener('keydown', event => {
      if (event.target !== row || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      if (event.key === 'Home' || event.key === 'End') row.scrollTo({ left: event.key === 'Home' ? 0 : row.scrollWidth, behavior: reducedMotion.matches ? 'auto' : 'smooth' });
      else snapRound(row, event.key === 'ArrowRight' ? 1 : -1);
    });
  }
  async function openCategoryPurchase(categoryId) {
    if (purchasingCategory) return;
    const epoch = saveEpoch, request = ++loadNumber, difficulty = selectionDifficulty;
    await refreshSave();
    if (epoch !== saveEpoch || request !== loadNumber || localResetGuard || !$('library-dialog').open || difficulty !== selectionDifficulty) return;
    const category = Journey.track(saved, catalog, difficulty).categories.find(item => item.id === categoryId);
    if (!category || category.unlocked || !category.available || cloudBlocked()) { renderLibrary(); return; }
    categoryPurchase = { id: categoryId, difficulty, epoch: saveEpoch };
    const cost = Journey.CATEGORY_COST[difficulty];
    $('category-unlock-title').textContent = `Unlock ${category.name}?`;
    const costLine = $('category-unlock-cost'); costLine.replaceChildren();
    const gem = document.createElement('img'); gem.src = 'assets/gem-128.png'; gem.alt = '';
    costLine.append(gem, document.createTextNode(`${cost} gems · ${difficulty}`));
    $('category-unlock-message').textContent = saved.wallet.gems < cost ? 'Not enough gems' : `${saved.wallet.gems.toLocaleString()} gems available`;
    $('category-unlock-confirm').disabled = saved.wallet.gems < cost;
    if (!$('category-unlock-dialog').open) $('category-unlock-dialog').showModal();
    placeBanners();
  }
  function nextRound(difficulty = saved.activeDifficulty) {
    if (!catalog) return null;
    const track = Journey.track(saved, catalog, difficulty);
    // Before the production order is assigned, preserve the agreed first puzzle.
    if (!catalog.configured && !Object.keys(saved.maps).length && difficulty === 'Easy') {
      return library.find(entry => entry.category === 'Farm Animals' && entry.difficulty === 'Easy')?.id || track.nextId;
    }
    return track.nextId;
  }
  function homeCategory(id) {
    const difficulty = library.find(entry => entry.id === id)?.difficulty || saved.activeDifficulty;
    for (const category of Journey.track(saved, catalog, difficulty).categories) {
      const round = category.rounds.find(item => item.id === id);
      if (round) return category.name;
    }
    const entry = library.find(item => item.id === id);
    return entry ? entry.category : 'Choose a round from Home';
  }
  function renderHome() {
    if (!catalog) return;
    const difficulty = saved.activeDifficulty;
    const target = Journey.continueId(saved, catalog, difficulty, puzzle?.difficulty === difficulty ? puzzle.id : '');
    const resume = target && saved.maps[target] && !saved.maps[target].complete;
    $('home-play').textContent = resume ? 'Resume' : 'Play';
    $('home-play').disabled = cloudBlocked();
    $('home-difficulty').textContent = `${difficulty || 'Easy'} difficulty`;
    $('home-difficulty').disabled = false;
    $('home-round').textContent = homeCategory(target);
    $('home-play').dataset.seed = target || '';
  }
  function renderGems() {
    const amount = saved.wallet.gems;
    const label = amount.toLocaleString();
    $('gem-count').textContent = label;
    $('gem-balance').setAttribute('aria-label', `Gems: ${label}`);
  }
  function renderRoundBackground() {
    const background = $('round-background');
    if (background.getAttribute('src') !== HOME_BACKGROUND) {
      background.hidden = true;
      background.setAttribute('src', HOME_BACKGROUND);
    }
    // Use the home artwork throughout the game. A missing image
    // leaves the solid page backdrop in place.
    background.hidden = !background.complete || background.naturalWidth === 0;
  }
  function showScreen(next) {
    if (next !== 'game') clearWordTransitions();
    screen = next;
    $('home-screen').hidden = next !== 'home';
    $('game-layout').hidden = next !== 'game';
    $('home-button').hidden = next !== 'game';
    $('gem-balance').hidden = next === 'home';
    $('selection-text').hidden = next !== 'game';
    document.querySelector('.app').classList.toggle('is-home', next === 'home');
    document.body.classList.toggle('is-home', next === 'home');
    if (next === 'home') {
      renderHome(); document.title = 'Word Search · Gomer Games';
    }
    renderRoundBackground();
    scheduleFit();
  }
  async function goHome() {
    clearWordTransitions();
    cancelSelection(); const request = ++loadNumber;
    // A failed round's error doesn't belong on Home, where Retry would reopen that round.
    if (retryAction !== bootRetry) { $('load-error').hidden = true; placeBanners(); }
    await refreshSave();
    if (request !== loadNumber) return;
    applyProgress();
    showScreen('home'); $('home-play').focus({ preventScroll: true });
  }
  async function playNext(resume = false) {
    const request = ++loadNumber;
    await refreshSave();
    if (request !== loadNumber) return;
    const difficulty = !resume && puzzle ? puzzle.difficulty : saved.activeDifficulty;
    const target = Journey.continueId(saved, catalog, difficulty, puzzle?.difficulty === difficulty ? puzzle.id : '');
    if (target) await loadPuzzle(target, request);
    else openLibrary();
  }
  function renderBonus() {
    const { found: count, total, ready, opened } = Journey.chestProgress(saved, puzzle);
    $('bonus-button').classList.toggle('is-ready', ready);
    $('bonus-button').setAttribute('aria-label', opened ? 'Bonus Chest, collected for this map'
      : ready ? 'Bonus Chest, ready to open for this map' : `Bonus Chest, ${count} of ${total} bonus words found on this map`);
    $('bonus-progress').setAttribute('aria-valuemax', total || 1);
    $('bonus-progress').setAttribute('aria-valuenow', count);
    $('bonus-progress-fill').style.width = `${total ? 100 * count / total : 0}%`;
    $('bonus-points').textContent = `${count} / ${total}`;
    $('chest-button').disabled = !ready || chestOpening === puzzle || cloudBlocked();
    $('chest-button').setAttribute('aria-label', opened ? 'Chest collected for this map' : 'Open this map’s chest');
    $('chest-button').classList.toggle('is-ready', ready);
    $('chest-status').textContent = opened ? 'Chest collected for this map'
      : ready ? `Tap the chest to collect ${Journey.GEMS_PER_CHEST} gems`
      : puzzle ? `Find all ${total} bonus words on this map to open its chest` : 'Choose a map to find its bonus words';
    $('bonus-map-title').textContent = puzzle?.title || '';
    const list = $('bonus-found-list'); list.replaceChildren();
    for (const word of foundBonus) {
      const item = document.createElement('li'); item.textContent = word; list.append(item);
    }
    $('bonus-empty').hidden = foundBonus.size > 0;
  }
  function celebrateBonus(word) {
    window.WordSearchCelebration.bonus($('bonus-button'));
    const feedback = $('bonus-feedback');
    const ready = Journey.chestProgress(saved, puzzle).ready;
    const long = ready ? `${word} · Bonus chest ready!` : `${word} · Bonus word found`;
    const short = ready ? `${word} · Chest ready!` : `${word} · bonus`;
    // Sit in the empty space right of the gem balance, shortening the text if
    // needed. On screens too narrow even for that, show it at the top of the
    // board instead, so it never covers the gems or the controls.
    const gems = $('gem-balance').getBoundingClientRect(), board = $('board').getBoundingClientRect();
    const room = board.right - gems.right - 8;
    feedback.style.transition = 'none';
    feedback.classList.remove('beside-gems', 'over-board', 'is-visible');
    feedback.style.setProperty('--beside-left', `${gems.right + 8}px`);
    feedback.style.setProperty('--beside-top', `${gems.top + gems.height / 2}px`);
    feedback.style.setProperty('--beside-width', `${room}px`);
    feedback.style.setProperty('--board-center', `${board.left + board.width / 2}px`);
    feedback.style.setProperty('--board-top', `${board.top + 8}px`);
    feedback.style.setProperty('--board-width', `${board.width - 16}px`);
    let placed = false;
    if (!$('gem-balance').hidden) {
      for (const text of [long, short]) {
        feedback.textContent = text; feedback.classList.add('beside-gems');
        // The message never wraps beside the gems, so scrollWidth is its full width.
        if (feedback.scrollWidth <= room) { placed = true; break; }
        feedback.classList.remove('beside-gems');
      }
    }
    if (!placed) { feedback.textContent = long; feedback.classList.add('over-board'); }
    // Apply the position before fading in, so the message never slides across the gems.
    void feedback.offsetWidth;
    feedback.style.removeProperty('transition');
    feedback.classList.add('is-visible'); clearTimeout(feedbackTimer);
    feedbackTimer = setTimeout(() => feedback.classList.remove('is-visible'), 2200);
  }
  async function readPuzzle(entry) {
    const raw = await readJSON(entry.path, entry.contentSha256);
    let value;
    try { value = Engine.validateSeed(raw); }
    catch (error) { throw problem('damaged', error.message); }
    for (const key of ['id', 'title', 'category', 'difficulty', 'rows', 'cols']) {
      if (value[key] !== entry[key]) throw problem('damaged', `The puzzle's ${key} does not match its library entry.`);
    }
    if (value.words.length !== entry.wordCount) throw problem('damaged', 'The puzzle word count does not match its library entry.');
    return value;
  }
  async function loadPuzzle(id, request = ++loadNumber) {
    if (cloudBlocked()) { openCloudDialog(); return false; }
    const entry = library.find(item => item.id === id);
    if (!entry) { showError('notListed', () => openLibrary()); return false; }
    const round = Journey.track(saved, catalog, entry.difficulty).categories.flatMap(category => category.rounds)
      .find(item => item.id === id);
    if (!round?.unlocked || !round.available) { announce('Complete earlier rounds to unlock this puzzle.'); return false; }
    $('game-layout').setAttribute('aria-busy', 'true');
    try {
      const validated = await readPuzzle(entry);
      if (request !== loadNumber) return false;
      let opened = true;
      try {
        opened = await updateSave(state => {
          if (request !== loadNumber) return false;
          Journey.visit(state, validated);
          Journey.setDifficulty(state, validated.difficulty);
          return true;
        });
      } catch (error) {
        // The round still opens from the last saved copy; the notice explains.
        if (!error?.saveFailure) throw error;
      }
      if (!opened || request !== loadNumber) return false;
      openPuzzle(validated);
      $('load-error').hidden = true;
      return true;
    } catch (error) {
      if (request !== loadNumber) return false;
      showError(error?.kind || 'damaged', async () => {
        if (await loadPuzzle(id) && $('library-dialog').open) $('library-dialog').close();
      }, error);
      return false;
    } finally {
      if (request === loadNumber) $('game-layout').setAttribute('aria-busy', 'false');
    }
  }
  function openPuzzle(value) {
    clearWordTransitions();
    cancelSelection();
    clearTimeout(hintTimer); hint = null; lastHint = ''; clearTimeout(missTimer); miss = [];
    puzzle = value; applyProgress(); completionOpen = false; unlockedCategory = ''; unlockedCategoryId = ''; gemsAwarded = 0;
    activeCell = { row: 0, col: 0 };
    $('word-list-title').textContent = puzzle.title.toUpperCase();
    document.title = `${puzzle.title.toUpperCase()} · Gomer Games`;
    $('board').setAttribute('aria-label', `${puzzle.title}, ${puzzle.rows} rows by ${puzzle.cols} columns word search`);
    $('hint-button').disabled = false;
    showScreen('game'); renderBoard(); renderProgress(); renderLibrary();
    focusCell(activeCell);
  }
  function renderBoard() {
    const board = $('board'), letters = $('letters');
    board.style.setProperty('--rows', puzzle.rows);
    board.style.setProperty('--cols', puzzle.cols);
    board.dataset.rows = puzzle.rows;
    board.dataset.cols = puzzle.cols;
    board.classList.toggle('large-board', puzzle.cols > 12);
    board.setAttribute('aria-rowcount', puzzle.rows); board.setAttribute('aria-colcount', puzzle.cols);
    $('highlights').setAttribute('viewBox', `0 0 ${puzzle.cols * 100} ${puzzle.rows * 100}`);
    letters.replaceChildren();
    puzzle.grid.forEach((row, r) => {
      const rowElement = document.createElement('div'); rowElement.className = 'grid-row'; rowElement.setAttribute('role', 'row');
      row.forEach((letter, c) => {
        const cell = document.createElement('button'); cell.className = 'cell'; cell.type = 'button';
        cell.setAttribute('role', 'gridcell'); cell.dataset.row = r; cell.dataset.col = c;
        cell.setAttribute('aria-label', `${letter}, row ${r + 1}, column ${c + 1}`);
        cell.setAttribute('aria-rowindex', r + 1); cell.setAttribute('aria-colindex', c + 1);
        cell.tabIndex = r === 0 && c === 0 ? 0 : -1; cell.textContent = letter; rowElement.append(cell);
      });
      letters.append(rowElement);
    });
  }
  function line(cells, color, { width = 70, opacity = .72, parent = $('highlights') } = {}) {
    if (!cells.length) return;
    const first = cells[0], last = cells[cells.length - 1];
    const node = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    for (const [name, value] of Object.entries({ x1: first.col * 100 + 50, y1: first.row * 100 + 50,
      x2: last.col * 100 + 50 + (cells.length === 1 ? .01 : 0), y2: last.row * 100 + 50,
      stroke: color, 'stroke-width': width, 'stroke-linecap': 'round', opacity })) node.setAttribute(name, value);
    parent.append(node);
    return node;
  }
  // The selection keeps its light yellow behind the letters, inside a dark
  // outline that stands out 4.5:1 against the board.
  function selectionLine(cells) {
    line(cells, '#9c6b16', { width: 80, opacity: 1 });
    line(cells, '#eeca7e', { width: 70, opacity: 1 });
  }
  // These records outlive SVG redraws and keep the selected line visible while
  // saving. Only a committed discovery can start its glow and confetti.
  function clearWordTransitions() {
    for (const transition of wordTransitions.values()) {
      clearTimeout(transition.timer); clearTimeout(transition.burstTimer);
      transition.cancelBurst?.();
    }
    wordTransitions.clear();
  }
  reducedMotion.addEventListener('change', () => {
    if (!reducedMotion.matches) return;
    clearWordTransitions();
    if (puzzle) renderProgress();
  });
  function transitionStyle(node, transition) {
    node.style.setProperty('--word-duration', `${WORD_TRANSITION_MS}ms`);
    node.style.setProperty('--word-delay', `${Math.min(0, transition.started - performance.now())}ms`);
    node.style.setProperty('--found-color', transition.color);
  }
  function bonusHighlight(transition) {
    const group = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    // Composite the gold ring and fill together so their overlap doesn't
    // hide the other words beneath two nearly opaque strokes.
    group.setAttribute('opacity', .72);
    if (transition) {
      group.classList.add('bonus-settle');
      transitionStyle(group, transition);
    }
    $('highlights').append(group);
    return group;
  }
  function wordTransitionLine(transition) {
    if (transition.started === null) { selectionLine(transition.cells); return; }
    const { cells, color, isBonus } = transition;
    const glow = line(cells, color, { width: 90, opacity: 0 });
    const parent = isBonus ? bonusHighlight(transition) : $('highlights');
    const ring = line(cells, isBonus ? '#c99a2c' : color, { width: isBonus ? 76 : 70, opacity: isBonus ? .9 : 0, parent });
    const fill = line(cells, color, { width: isBonus ? 66 : 70, opacity: isBonus ? .92 : .72, parent });
    for (const [node, part] of [[glow, 'glow'], [ring, 'ring'], [fill, 'fill']]) {
      node.classList.add(`word-${part}`);
      transitionStyle(node, transition);
      node.style.setProperty('--rest-stroke', node.getAttribute('stroke'));
      node.style.setProperty('--rest-width', node.getAttribute('stroke-width'));
      node.style.setProperty('--rest-opacity', node.getAttribute('opacity'));
    }
  }
  function startWordTransition(transition) {
    if (!transition || wordTransitions.get(transition.word) !== transition) return false;
    if (screen !== 'game' || reducedMotion.matches) {
      wordTransitions.delete(transition.word);
      if (screen === 'game' && transition.isBonus && !document.querySelector('dialog[open]')) celebrateBonus(transition.word);
      return false;
    }
    transition.started = performance.now();
    transition.burstTimer = setTimeout(() => {
      if (wordTransitions.get(transition.word) !== transition || screen !== 'game' || reducedMotion.matches) return;
      if (!document.querySelector('dialog[open]')) {
        transition.cancelBurst = window.WordSearchCelebration?.word(transition.cells.map(cellElement), transition.color);
        if (transition.isBonus) celebrateBonus(transition.word);
      }
    }, WORD_BURST_MS);
    transition.timer = setTimeout(() => {
      if (wordTransitions.get(transition.word) !== transition) return;
      wordTransitions.delete(transition.word);
      transition.cancelBurst?.();
      if (puzzle) renderProgress();
    }, WORD_TRANSITION_MS);
    return true;
  }
  function renderHighlights() {
    $('highlights').replaceChildren();
    const foundCells = new Set();
    puzzle.words.forEach((entry, i) => {
      if (!found.has(entry.word)) return;
      const transition = wordTransitions.get(entry.word);
      if (transition) wordTransitionLine(transition);
      else line(entry.cells, COLORS[i % COLORS.length]);
      entry.cells.forEach(cell => foundCells.add(`${cell.row},${cell.col}`));
    });
    // Translucent gold keeps bonus words distinct while crossing colors show through.
    for (const entry of puzzle.bonusWords) {
      if (!foundBonus.has(entry.word)) continue;
      const transition = wordTransitions.get(entry.word);
      if (transition) wordTransitionLine(transition);
      else {
        const parent = bonusHighlight();
        line(entry.cells, '#c99a2c', { width: 76, opacity: .9, parent });
        line(entry.cells, '#f7e4a3', { width: 66, opacity: .92, parent });
      }
      entry.cells.forEach(cell => foundCells.add(`${cell.row},${cell.col}`));
    }
    // A line that isn't a word shows briefly, then fades.
    if (miss.length) {
      // Redraws continue the fade from where it was instead of restarting it.
      const node = line(miss, '#d98f86', { opacity: .7 });
      node.classList.add('miss-line'); node.style.animationDelay = `${missStarted - performance.now()}ms`;
    }
    for (const transition of wordTransitions.values()) {
      if (!found.has(transition.word) && !foundBonus.has(transition.word)) wordTransitionLine(transition);
    }
    selectionLine(selected);
    document.querySelectorAll('.cell').forEach(cell => {
      const key = `${cell.dataset.row},${cell.dataset.col}`, isFound = foundCells.has(key);
      cell.classList.toggle('found', isFound);
      // Screen readers hear which letters belong to found words.
      const row = +cell.dataset.row, col = +cell.dataset.col;
      const label = `${puzzle.grid[row][col]}, row ${row + 1}, column ${col + 1}${isFound ? ', found' : ''}`;
      if (cell.getAttribute('aria-label') !== label) cell.setAttribute('aria-label', label);
      cell.classList.toggle('hinted', !!hint && key === `${hint.start.row},${hint.start.col}`);
      cell.setAttribute('aria-selected', String(selected.some(p => p.row === +cell.dataset.row && p.col === +cell.dataset.col)));
    });
    const feedback = [...wordTransitions.values()].at(-1);
    const confirming = !selected.length && feedback?.started != null;
    const selectionText = $('selection-text');
    if (confirming && (!selectionText.classList.contains('is-confirming') || selectionText.dataset.word !== feedback.word)) {
      selectionText.classList.remove('is-confirming');
      void selectionText.offsetWidth;
      transitionStyle(selectionText, feedback);
      selectionText.dataset.word = feedback.word;
    }
    $('selection-text').textContent = selected.length
      ? selected.map(cell => puzzle.grid[cell.row][cell.col]).join('') : feedback?.word || '';
    $('selection-text').classList.toggle('is-confirming', confirming);
    document.querySelectorAll('#word-list li').forEach(item =>
      item.classList.toggle('is-hinted', item.dataset.word === hint?.word));
  }
  function renderProgress() {
    const list = $('word-list'); list.replaceChildren();
    for (const entry of puzzle.words) {
      const item = document.createElement('li'), label = document.createElement('span');
      const done = found.has(entry.word);
      item.className = done ? 'is-found' : ''; item.dataset.word = entry.word;
      const transition = wordTransitions.get(entry.word);
      if (done && transition?.started != null) {
        item.classList.add('is-finding'); transitionStyle(item, transition);
      }
      item.setAttribute('aria-label', `${entry.word}${done ? ', found' : ', not yet found'}`);
      label.className = 'word-label'; label.textContent = entry.word; item.append(label); list.append(item);
    }
    $('progress-count').textContent = `${found.size} / ${puzzle.words.length}`;
    $('progress-fill').style.width = `${100 * found.size / puzzle.words.length}%`;
    $('progress').setAttribute('aria-valuemax', puzzle.words.length); $('progress').setAttribute('aria-valuenow', found.size);
    const complete = found.size === puzzle.words.length;
    const completion = $('completion'), wasHidden = completion.hidden;
    const focusWasInCompletion = completion.contains(document.activeElement);
    const settling = [...wordTransitions.values()].some(transition => transition.started !== null);
    completion.hidden = !completionOpen || settling;
    $('board').inert = completionOpen || cloudBlocked();
    $('hint-button').disabled = complete;
    $('keep-searching').hidden = foundBonus.size === puzzle.bonusWords.length;
    $('unlock-message').hidden = !unlockedCategory;
    $('unlock-message').textContent = unlockedCategory ? `New Category Unlocked: ${unlockedCategory}` : '';
    $('play-unlocked').hidden = !unlockedCategoryId;
    $('play-unlocked').textContent = unlockedCategory ? `Play ${unlockedCategory}` : 'Play new category';
    $('next-button').textContent = 'Continue';
    $('gem-reward').hidden = !completionOpen || gemsAwarded <= 0;
    $('gem-reward-count').textContent = gemsAwarded > 0 ? `+${gemsAwarded.toLocaleString()} gems` : '';
    renderBonus();
    renderHighlights();
    if (!completion.hidden && wasHidden && screen === 'game' && !document.querySelector('dialog[open]')) {
      $('toast').textContent = '';
      $('next-button').focus({ preventScroll: true });
    } else if (completion.hidden && focusWasInCompletion) focusCell(activeCell);
    scheduleFit();
  }
  function cellElement(cell) { return $('letters').querySelector(`[data-row="${cell.row}"][data-col="${cell.col}"]`); }
  function focusCell(cell, focus = true) {
    cellElement(activeCell)?.setAttribute('tabindex', '-1'); activeCell = cell;
    const element = cellElement(cell); element.tabIndex = 0; if (focus) element.focus({ preventScroll: true });
  }
  function cancelSelection() {
    anchor = null; selected = []; pointer = null;
    if (puzzle) renderHighlights();
  }
  async function chooseEnd(cell) {
    if (completionOpen) { cancelSelection(); return; }
    if (!anchor) {
      anchor = cell; selected = [cell]; renderHighlights();
      announce(`Start ${puzzle.grid[cell.row][cell.col]}.`);
      return;
    }
    if (anchor.row === cell.row && anchor.col === cell.col) { cancelSelection(); return; }
    selected = Engine.getLine(anchor, cell, puzzle);
    const selectedPuzzle = puzzle, word = Engine.matchSelection(selectedPuzzle, selected);
    const isBonus = word && selectedPuzzle.bonusWords.some(entry => entry.word === word);
    const straight = selected.length > 0;
    const attempted = selected;
    if (wordTransitions.has(word)) { cancelSelection(); return; }
    const transition = word && !found.has(word) && !foundBonus.has(word) ? {
      word, cells: attempted, isBonus, started: null,
      color: isBonus ? '#f7e4a3' : COLORS[selectedPuzzle.words.findIndex(entry => entry.word === word) % COLORS.length]
    } : null;
    if (transition) wordTransitions.set(word, transition);
    cancelSelection();
    if (!word) {
      announce(straight ? 'Not on the list.' : 'Select a straight line.');
      if (straight) showMiss(attempted);
      return;
    }
    let result;
    try {
      result = await updateSave(state => {
        const discovery = Journey.discover(state, selectedPuzzle, word, isBonus);
        const progression = discovery.completedNow ? Journey.advanceProgression(state, catalog, selectedPuzzle.difficulty) : null;
        const newlyUnlocked = progression?.unlocked[0];
        return { ...discovery, unlocked: newlyUnlocked?.name || '', unlockedId: newlyUnlocked?.id || '' };
      });
    } catch (error) {
      if (wordTransitions.get(word) === transition) {
        wordTransitions.delete(word);
        if (puzzle === selectedPuzzle) renderHighlights();
      }
      // Not kept: the word stays unfound so it can be selected again; the notice explains.
      if (!error?.saveFailure) throw error;
      return;
    }
    if (puzzle !== selectedPuzzle) return;
    applyProgress();
    if (result.isNew) {
      hint = null; clearTimeout(hintTimer);
      startWordTransition(transition);
      if (result.completedNow || (isBonus && found.size === puzzle.words.length && foundBonus.size === puzzle.bonusWords.length)) {
        completionOpen = true; unlockedCategory = result.unlocked;
        unlockedCategoryId = result.unlockedId || '';
        gemsAwarded = result.completedNow ? result.gemsAwarded || 0 : 0;
      }
      renderProgress(); renderLibrary(); renderHome();
      announce((isBonus ? `Bonus word ${word} found.${Journey.chestProgress(saved, selectedPuzzle).ready ? ' This map’s bonus chest is ready to open.' : ''}` : `${word} found.`) +
        (result.completedNow ? ' Puzzle complete!' : '') +
        (gemsAwarded > 0 && result.completedNow ? ` ${gemsAwarded} gems earned.` : '') +
        (result.completedNow && result.unlocked ? ` New category unlocked: ${result.unlocked}.` : ''));
    } else {
      if (wordTransitions.get(word) === transition) wordTransitions.delete(word);
      renderProgress(); announce(`${word} is already found.`);
    }
  }
  function cellAt(event) {
    if (!puzzle) return null;
    const rect = $('letters').getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX >= rect.right || event.clientY < rect.top || event.clientY >= rect.bottom) return null;
    return { row: Math.floor((event.clientY - rect.top) / rect.height * puzzle.rows), col: Math.floor((event.clientX - rect.left) / rect.width * puzzle.cols) };
  }
  // A press becomes a drag only after moving this far, in letters, from where it began.
  const DRAG_THRESHOLD = .4;
  // A letter joins a dragged line once the finger is this far into it.
  const LETTER_ENTRY = .25;
  function cellSize() {
    const rect = $('letters').getBoundingClientRect();
    return { rect, width: rect.width / puzzle.cols, height: rect.height / puzzle.rows };
  }
  function updateDragSelection(event) {
    const { rect, width, height } = cellSize();
    // Measure from the centre of the drag's first letter, not from the press point.
    selected = Engine.getDragLine(anchor, {
      row: (event.clientY - rect.top) / height - anchor.row - .5,
      col: (event.clientX - rect.left) / width - anchor.col - .5
    }, puzzle, LETTER_ENTRY);
    renderHighlights();
  }
  function endPointer(id) {
    pointer = null;
    if ($('board').hasPointerCapture(id)) $('board').releasePointerCapture(id);
  }
  // Returns true when the drag covered an unfound word and has ended.
  function trackPointer(event) {
    let before = selected;
    if (!pointer.dragging) {
      const { width, height } = cellSize();
      if (Math.hypot((event.clientX - pointer.x) / width, (event.clientY - pointer.y) / height) < DRAG_THRESHOLD) return false;
      // A drag always starts at the pressed letter, replacing any end picked by an earlier tap.
      pointer.dragging = true; anchor = pointer.start; before = [anchor];
    }
    updateDragSelection(event);
    // A fast flick can pass several letters in one event, so check every length it covered.
    const extended = before.every((cell, index) => cell.row === selected[index]?.row && cell.col === selected[index]?.col);
    for (let length = Math.max(2, extended ? before.length + 1 : selected.length); length <= selected.length; length += 1) {
      const line = selected.slice(0, length), word = Engine.matchSelection(puzzle, line);
      if (!word || found.has(word) || foundBonus.has(word)) continue;
      // An unfound word is accepted as soon as the line covers it, without lifting.
      endPointer(event.pointerId);
      chooseEnd(line[line.length - 1]);
      return true;
    }
    return false;
  }
  $('board').addEventListener('pointerdown', event => {
    if (!puzzle || pointer || !event.isPrimary || event.button !== 0) return;
    const cell = cellAt(event); if (!cell) return;
    event.preventDefault(); focusCell(cell);
    pointer = { id: event.pointerId, start: cell, previous: anchor, x: event.clientX, y: event.clientY, dragging: false };
    if (!anchor) { anchor = cell; selected = [cell]; }
    $('board').setPointerCapture(event.pointerId); renderHighlights();
  });
  $('board').addEventListener('pointermove', event => {
    if (!pointer || event.pointerId !== pointer.id) return;
    trackPointer(event);
  });
  $('board').addEventListener('pointerup', event => {
    if (!pointer || event.pointerId !== pointer.id) return;
    if (trackPointer(event)) return; // A release can be the first event past the threshold.
    const operation = pointer; endPointer(event.pointerId);
    if (operation.dragging && selected.length > 1) { chooseEnd(selected[selected.length - 1]); return; }
    // A tap, or a drag that returned to its first letter, picks the pressed letter as one end.
    anchor = operation.previous; selected = anchor ? [anchor] : [];
    chooseEnd(operation.start);
  });
  // Only the dragging finger can cancel its drag; a second finger's touch is ignored.
  const ownPointer = event => pointer && event.pointerId === pointer.id;
  $('board').addEventListener('pointercancel', event => { if (ownPointer(event)) cancelSelection(); });
  $('board').addEventListener('lostpointercapture', event => { if (ownPointer(event)) cancelSelection(); });
  $('board').addEventListener('contextmenu', event => event.preventDefault());
  $('board').addEventListener('keydown', event => {
    if (!puzzle) return;
    // Keys act on the focused letter; assistive technology can focus any letter directly.
    const focused = event.target.closest?.('.cell');
    if (focused && (+focused.dataset.row !== activeCell.row || +focused.dataset.col !== activeCell.col)) {
      focusCell({ row: +focused.dataset.row, col: +focused.dataset.col }, false);
    }
    const delta = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] }[event.key];
    if (delta) {
      event.preventDefault();
      focusCell({ row: Math.max(0, Math.min(puzzle.rows - 1, activeCell.row + delta[0])), col: Math.max(0, Math.min(puzzle.cols - 1, activeCell.col + delta[1])) });
      if (anchor) {
        // Off a straight line, keep the first end highlighted instead of clearing it.
        const path = Engine.getLine(anchor, activeCell, puzzle);
        selected = path.length ? path : [anchor]; renderHighlights();
        // Keyboard and screen-reader players hear the letters they would select.
        announce(path.length ? path.map(cell => puzzle.grid[cell.row][cell.col]).join(' ') : 'Not a straight line.');
      }
    } else if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); chooseEnd(activeCell); }
    else if (event.key === 'Escape') { event.preventDefault(); cancelSelection(); }
  });
  // Keyboard-generated and assistive-technology clicks have no pointer event.
  $('board').addEventListener('click', event => {
    if (event.detail !== 0 || !puzzle) return;
    const element = event.target.closest('.cell'); if (!element) return;
    const cell = { row: +element.dataset.row, col: +element.dataset.col }; focusCell(cell); chooseEnd(cell);
  });
  window.addEventListener('blur', cancelSelection);
  window.addEventListener('resize', () => { cancelSelection(); scheduleFit(); });
  window.visualViewport?.addEventListener('resize', scheduleFit);
  window.visualViewport?.addEventListener('scroll', scheduleFit);
  new ResizeObserver(scheduleFit).observe(document.querySelector('.app'));
  document.fonts?.ready.then(scheduleFit);
  document.addEventListener('visibilitychange', () => { if (document.hidden) cancelSelection(); });
  window.addEventListener('storage', async event => {
    if (localResetGuard || localConflictGuard || event.key !== storageKey) return;
    // An explicitly selected cloud save may have a lower revision.
    await refreshSave();
    if (puzzle) {
      const wasComplete = found.size === puzzle.words.length, previousBonus = foundBonus.size;
      applyProgress();
      if (found.size !== puzzle.words.length) {
        // Another tab can deliberately replace a completed save with an
        // unfinished one. Its old completion overlay must not lock this board.
        completionOpen = false; gemsAwarded = 0; unlockedCategory = ''; unlockedCategoryId = '';
      } else if (!wasComplete ||
        (previousBonus < puzzle.bonusWords.length && foundBonus.size === puzzle.bonusWords.length)) {
        completionOpen = true; gemsAwarded = 0;
      }
      renderProgress();
    }
    renderHome(); renderLibrary(); renderBonus(); renderGems();
  });
  window.addEventListener('wordsearch-storage-state', event => {
    if (event.detail?.mode === 'conflict') stopForLocalConflict();
    else if (event.detail?.mode === 'memory') setSaveMode('memory');
    else if (event.detail?.mode === 'device') setSaveMode('device');
  });

  function stopForLocalConflict() {
    if (localConflictGuard) return;
    localConflictGuard = true;
    ++saveEpoch; ++loadNumber;
    // Retire queued gameplay, account transitions and cloud work without
    // clearing either save, changing account ownership or inventing a merge.
    cloudController?.stop(); cloudController = null;
    activeStore = window.WordSearchStore;
    cloudReady = false; switchingSave = true;
    clearWordTransitions(); cancelSelection();
    clearTimeout(hintTimer); clearTimeout(missTimer); clearTimeout(feedbackTimer);
    $('game-layout').setAttribute('aria-busy', 'false');
    $('board').inert = true;
    document.querySelector('.app').inert = true;
    document.querySelectorAll('dialog[open]').forEach(dialog => dialog.close());
    setSaveMode('conflict');
    $('local-conflict-dialog').showModal();
    $('local-conflict-download').focus({ preventScroll: true });
    placeBanners();
  }
  $('local-conflict-dialog').addEventListener('cancel', event => event.preventDefault());
  $('local-conflict-download').addEventListener('click', () => {
    const conflict = window.WordSearchStore?.conflict;
    if (!conflict) return;
    let url;
    try {
      // This is an explicit local download, not an upload or an automatic
      // restore. It retains both branches for support/manual recovery.
      const backup = { format: 'wordsearch-local-recovery-v1', ...conflict };
      url = URL.createObjectURL(new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' }));
      const link = document.createElement('a');
      link.href = url; link.download = 'wordsearch-recovery-copies.json';
      document.body.append(link); link.click(); link.remove();
      $('local-conflict-message').textContent = 'Recovery download requested. Check that the file saved before reloading. It is for manual recovery; the game cannot import it automatically.';
    } catch {
      $('local-conflict-message').textContent = 'The recovery download could not start. Keep this tab open so its unsaved progress remains available.';
    } finally {
      if (url) setTimeout(() => URL.revokeObjectURL(url), 60000);
    }
  });
  $('local-conflict-reload').addEventListener('click', async () => {
    const button = $('local-conflict-reload');
    if (button.disabled) return;
    button.disabled = true;
    $('local-conflict-message').textContent = 'Checking the saved device progress…';
    try {
      // A stale fallback marker can survive reload. Resolve that authority only
      // after this explicit discard choice, then start a fresh game session.
      await window.WordSearchStore.useDeviceSave();
      location.reload();
    } catch {
      $('local-conflict-message').textContent = 'Could not safely reload the saved progress. Keep this tab open, close other Word Search tabs, allow site storage, then try again. Your recovery copies are still available to download.';
    } finally { button.disabled = false; }
  });

  function showMiss(cells) {
    miss = cells; missStarted = performance.now(); clearTimeout(missTimer); renderHighlights();
    missTimer = setTimeout(() => { miss = []; if (puzzle) renderHighlights(); }, 600);
  }
  $('hint-button').addEventListener('click', () => {
    if (!puzzle) return;
    cancelSelection(); clearTimeout(hintTimer);
    // Each hint moves on to the next unfound word, so repeated taps don't repeat one word.
    const unfound = puzzle.words.filter(word => !found.has(word.word)); if (!unfound.length) return;
    const after = puzzle.words.findIndex(word => word.word === lastHint);
    const entry = unfound.find(word => puzzle.words.indexOf(word) > after) || unfound[0];
    hint = { word: entry.word, start: entry.start }; lastHint = entry.word; renderHighlights();
    announce(`${entry.word}: row ${entry.start.row + 1}, column ${entry.start.col + 1}.`);
    hintTimer = setTimeout(() => { hint = null; if (puzzle) renderHighlights(); }, 5000);
  });
  $('round-background').addEventListener('load', renderRoundBackground);
  $('round-background').addEventListener('error', renderRoundBackground);
  // Open the list at the round being played, or else the next round to play.
  function revealRound() {
    const list = $('library-list'), next = Journey.continueId(saved, catalog, selectionDifficulty, puzzle?.difficulty === selectionDifficulty ? puzzle.id : '');
    alignRoundRows();
    const card = list.querySelector('.library-card.current') ||
      (next && list.querySelector(`.library-card[data-seed="${CSS.escape(next)}"]`));
    if (card) card.closest('.category-section').scrollIntoView({ block: 'start' });
    else $('library-dialog').scrollTop = 0;
  }
  function alignRoundRows() {
    document.querySelectorAll('.category-rounds').forEach(row => {
      const cards = [...row.querySelectorAll('.library-card')];
      const target = cards.find(card => card.dataset.seed === row.dataset.frontier) || cards.filter(card => !card.disabled).at(-1) || cards[0];
      if (target) row.scrollLeft = target.getBoundingClientRect().left - row.getBoundingClientRect().left + row.scrollLeft - 3;
    });
  }
  async function openLibrary() {
    if (!catalog) return;
    cancelSelection(); const request = ++loadNumber;
    await refreshSave();
    if (request !== loadNumber) return;
    selectionDifficulty = saved.activeDifficulty;
    renderLibrary();
    if (!$('library-dialog').open) $('library-dialog').showModal();
    renderSaveNotice();
    document.querySelector(`#difficulty-tabs [data-difficulty="${selectionDifficulty}"]`).focus({ preventScroll: true });
    revealRound();
  }
  $('home-play').addEventListener('click', () => playNext(true));
  $('home-button').addEventListener('click', goHome);
  $('completion-home').addEventListener('click', goHome);
  $('next-button').addEventListener('click', () => playNext());
  $('play-unlocked').addEventListener('click', async () => {
    const categoryId = unlockedCategoryId, difficulty = puzzle?.difficulty, selectedPuzzle = puzzle;
    const epoch = saveEpoch, request = ++loadNumber;
    await refreshSave();
    if (epoch !== saveEpoch || request !== loadNumber || localResetGuard || puzzle !== selectedPuzzle || categoryId !== unlockedCategoryId) return;
    const category = Journey.track(saved, catalog, difficulty).categories.find(item => item.id === categoryId && item.unlocked);
    const target = category?.rounds.find(round => round.available && round.unlocked && !round.complete);
    if (target) await loadPuzzle(target.id, request);
    else openLibrary();
  });
  $('category-unlock-cancel').addEventListener('click', () => $('category-unlock-dialog').close());
  $('category-unlock-dialog').addEventListener('cancel', event => { if (purchasingCategory) event.preventDefault(); });
  $('category-unlock-dialog').addEventListener('close', () => { categoryPurchase = null; });
  $('category-unlock-confirm').addEventListener('click', async () => {
    if (!categoryPurchase || purchasingCategory) return;
    const purchase = categoryPurchase;
    if (purchase.epoch !== saveEpoch || cloudBlocked()) { $('category-unlock-dialog').close(); return; }
    purchasingCategory = true; $('category-unlock-confirm').disabled = true;
    $('category-unlock-cancel').disabled = true;
    $('category-unlock-dialog').querySelector('.close-dialog').disabled = true;
    try {
      const result = await updateSave(state => {
        if (purchase.epoch !== saveEpoch) return { purchased: false, reason: 'account-changed' };
        return Journey.purchaseCategory(state, catalog, purchase.difficulty, purchase.id);
      });
      if (purchase.epoch !== saveEpoch || categoryPurchase !== purchase) return;
      if (result.purchased || result.reason === 'already-unlocked') {
        $('category-unlock-dialog').close(); renderLibrary(); renderHome();
        alignRoundRows();
        const section = $('library-list').querySelector(`[data-category="${CSS.escape(purchase.id)}"]`);
        section?.scrollIntoView({ block: 'start' });
        section?.querySelector('.library-card:not(:disabled)')?.focus({ preventScroll: true });
        announce(result.purchased ? `${result.category.name} unlocked.` : 'Category already unlocked.');
      } else {
        $('category-unlock-message').textContent = result.reason === 'insufficient-gems' ? 'Not enough gems' : 'This category is unavailable.';
      }
    } catch (error) {
      if (categoryPurchase === purchase) $('category-unlock-message').textContent = 'Could not save the unlock. Try again.';
      if (!error?.saveFailure) console.error('Category unlock failed.', error);
    } finally {
      purchasingCategory = false;
      $('category-unlock-cancel').disabled = false;
      $('category-unlock-dialog').querySelector('.close-dialog').disabled = false;
      if (categoryPurchase === purchase) $('category-unlock-confirm').disabled =
        purchase.epoch !== saveEpoch || cloudBlocked() || saved.wallet.gems < Journey.CATEGORY_COST[purchase.difficulty];
    }
  });
  $('keep-searching').addEventListener('click', () => {
    completionOpen = false; gemsAwarded = 0; renderProgress(); focusCell(activeCell);
  });
  $('library-button').addEventListener('click', () => {
    cancelSelection();
    if (!$('settings-dialog').open) $('settings-dialog').showModal();
    placeBanners();
  });
  $('home-difficulty').addEventListener('click', openLibrary);
  function stopForLocalReset() {
    localResetGuard = true;
    ++saveEpoch; ++loadNumber;
    $('game-layout').setAttribute('aria-busy', 'false');
    // Obsolete UI work may be waiting on another tab's lock. Its epoch guard
    // prevents writes when it resumes; the fresh game need not wait for it.
    saveQueue = Promise.resolve();
    cloudController?.stop(); cloudController = null;
    activeStore = window.WordSearchStore;
    accountUid = ''; accountStatus = 'guest'; latestAccount = { status: 'guest' };
    cloudStatus = ''; cloudDetail = null; cloudReady = false; switchingSave = true;
    clearWordTransitions(); cancelSelection();
    clearTimeout(hintTimer); clearTimeout(missTimer); clearTimeout(feedbackTimer);
    hint = null; miss = []; chestOpening = false;
    $('bonus-feedback').classList.remove('is-visible');
    document.querySelector('.app').inert = true;
    // Keep this intent even if the account module or network is unavailable.
    // The empty device save must never be uploaded or immediately restored.
    try {
      localStorage.setItem('gomer.account.signout.v1', `${Date.now()}-${Math.random()}`);
      localStorage.removeItem('gomer.account.session.v1');
    } catch { /* The live account module also has an in-memory sign-out guard. */ }
    try { void Promise.resolve(window.WordSearchAccount?.signOut?.()).catch(() => {}); }
    catch { /* Local deletion must not wait for account networking. */ }
    renderCloud(); renderAccountStatus();
  }
  function setDeleteBusy(busy) {
    deletingLocalData = busy;
    $('delete-local-confirm').disabled = busy;
    $('delete-local-cancel').disabled = busy;
    $('delete-local-dialog').setAttribute('aria-busy', String(busy));
  }
  function finishLocalReset(result) {
    saved = Journey.normalizeState(result.state);
    saveInitialized = !!catalog;
    puzzle = null; found = new Set(); foundBonus = new Set();
    selectionDifficulty = saved.activeDifficulty;
    completionOpen = false; unlockedCategory = ''; unlockedCategoryId = ''; gemsAwarded = 0; lastHint = '';
    $('letters').replaceChildren(); $('highlights').replaceChildren(); $('word-list').replaceChildren();
    $('word-list-title').textContent = ''; $('completion').hidden = true; $('hint-button').disabled = true;
    $('load-error').hidden = true;
    databaseReady = result.mode === 'device'; storageOK = databaseReady;
    localResetGuard = false; switchingSave = false; cloudReady = true;
    setDeleteBusy(false);
    document.querySelector('.app').inert = false;
    document.querySelectorAll('dialog[open]').forEach(dialog => dialog.close());
    setSaveMode(result.mode === 'device' ? 'device' : 'memory');
    renderCloud(); renderLibrary(); renderBonus(); renderGems();
    showScreen('home'); renderSaveNotice();
    announce('All local Word Search data deleted.');
    $('home-play').focus({ preventScroll: true });
    if (!catalog) void boot();
  }
  $('delete-local-data').addEventListener('click', () => {
    $('delete-local-message').textContent = '';
    $('delete-local-cancel').textContent = 'Cancel';
    $('delete-local-confirm').textContent = 'Delete local data';
    $('delete-local-dialog').showModal();
    $('delete-local-cancel').focus({ preventScroll: true });
    placeBanners();
  });
  $('delete-local-cancel').addEventListener('click', () => {
    if (deletingLocalData) return;
    if (localResetGuard) { location.reload(); return; }
    $('delete-local-dialog').close();
    $('delete-local-data').focus({ preventScroll: true });
  });
  $('delete-local-dialog').addEventListener('cancel', event => {
    if (deletingLocalData || localResetGuard) event.preventDefault();
  });
  $('delete-local-confirm').addEventListener('click', async () => {
    if (deletingLocalData) return;
    setDeleteBusy(true);
    $('delete-local-message').textContent = 'Deleting local data…';
    stopForLocalReset();
    try {
      if (!window.WordSearchStore?.clearLocalData) throw new Error('Local storage is unavailable.');
      const result = await window.WordSearchStore.clearLocalData();
      finishLocalReset(result);
    } catch {
      setDeleteBusy(false);
      $('delete-local-message').textContent = 'Could not delete all local data. Close other Word Search tabs and allow site storage, then try again.';
      $('delete-local-confirm').textContent = 'Try again';
      $('delete-local-cancel').textContent = 'Reload';
    }
  });
  function handleLocalReset({ external, phase, recovery = false } = {}) {
    if (!external) return;
    if (!localResetGuard) stopForLocalReset();
    if (phase === 'complete') { location.reload(); return; }
    if (!$('delete-local-dialog').open) $('delete-local-dialog').showModal();
    setDeleteBusy(phase !== 'failed' && !recovery);
    $('delete-local-message').textContent = phase === 'failed'
      ? 'Deletion in another tab could not finish. Close other Word Search tabs, then try again.'
      : recovery ? 'Local data deletion has not finished. You can retry it here.'
      : 'Local data is being deleted in another tab…';
    if (phase === 'failed' || recovery) {
      $('delete-local-confirm').textContent = 'Try again';
      $('delete-local-cancel').textContent = 'Reload';
    }
    placeBanners();
  }
  window.addEventListener('wordsearch-local-reset', event => handleLocalReset(event.detail));
  document.querySelectorAll('#difficulty-tabs [data-difficulty]').forEach(tab => {
    tab.addEventListener('click', async () => {
      selectionDifficulty = tab.dataset.difficulty;
      try { await updateSave(state => Journey.setDifficulty(state, selectionDifficulty)); }
      catch (error) {
        // Browsing the tab still works; Play keeps the saved difficulty.
        if (!error?.saveFailure) throw error;
      }
      renderLibrary(); renderHome(); revealRound();
    });
    tab.addEventListener('keydown', event => {
      const tabs = [...document.querySelectorAll('#difficulty-tabs [data-difficulty]')];
      const index = tabs.indexOf(tab);
      const offset = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
      const target = event.key === 'Home' ? tabs[0] : event.key === 'End' ? tabs[tabs.length - 1] :
        offset ? tabs[(index + offset + tabs.length) % tabs.length] : null;
      if (target) { event.preventDefault(); target.focus(); target.click(); }
    });
  });
  $('bonus-button').addEventListener('click', async () => {
    const epoch = saveEpoch, selectedPuzzle = puzzle;
    if (!selectedPuzzle) return;
    cancelSelection(); await refreshSave();
    if (epoch !== saveEpoch || puzzle !== selectedPuzzle || localResetGuard) return;
    applyProgress(); renderBonus();
    if (!$('bonus-dialog').open) $('bonus-dialog').showModal();
    renderSaveNotice();
  });
  $('chest-button').addEventListener('click', async () => {
    const epoch = saveEpoch, selectedPuzzle = puzzle;
    if (!selectedPuzzle || chestOpening === selectedPuzzle) return;
    chestOpening = selectedPuzzle; renderBonus();
    let reward = null;
    try {
      reward = await updateSave(state => {
        const before = state.wallet.gems;
        const opened = Journey.openChest(state, selectedPuzzle);
        return { opened, gemsAwarded: state.wallet.gems - before };
      });
    } catch (error) {
      // Not opened; this map's chest stays available and the notice explains.
      if (!error?.saveFailure) throw error;
    } finally {
      // The opening animation keeps the chest disabled; anything else re-enables it now.
      if (epoch === saveEpoch) {
        if (chestOpening === selectedPuzzle && (!reward?.opened || puzzle !== selectedPuzzle)) chestOpening = false;
        renderBonus();
      }
    }
    if (epoch !== saveEpoch || puzzle !== selectedPuzzle) return;
    if (reward?.opened) {
      window.WordSearchCelebration.chest($('chest-button'));
      const message = `Collected! +${reward.gemsAwarded} gems. This map’s chest is complete.`;
      $('chest-status').textContent = message;
      announce(`This map’s chest opened. ${reward.gemsAwarded} gems earned.`);
      setTimeout(() => {
        if (epoch !== saveEpoch) return;
        if (chestOpening === selectedPuzzle) chestOpening = false;
        if (puzzle !== selectedPuzzle) return;
        renderBonus(); $('chest-status').textContent = message;
      }, 1100);
    }
  });
  $('cloud-status').addEventListener('click', openCloudDialog);
  $('settings-cloud-save').addEventListener('click', () => {
    $('settings-dialog').close();
    openCloudDialog();
  });
  for (const [id, choice] of [['cloud-local', 'local'], ['cloud-remote', 'cloud']]) {
    $(id).addEventListener('click', async () => {
      const controller = cloudController, epoch = saveEpoch;
      if (!controller) return;
      $(id).disabled = true;
      try {
        await controller.resolveChoice(choice);
        if (epoch === saveEpoch && cloudReady && $('cloud-dialog').open) $('cloud-dialog').close();
      } catch {
        if (epoch === saveEpoch) $('cloud-message').textContent = 'That save could not be selected. Your progress is still kept. Try again.';
      } finally { $(id).disabled = false; }
    });
  }
  $('cloud-retry').addEventListener('click', async () => {
    const controller = cloudController, epoch = saveEpoch;
    await window.WordSearchAccount?.refresh?.();
    if (epoch !== saveEpoch) return;
    if (controller) await controller.sync({ checkpoint: true, after: saveQueue });
    else await selectAccount(latestAccount);
  });
  $('cloud-stay-guest').addEventListener('click', () => {
    void window.WordSearchAccount?.signOut?.();
  });
  function saveCloudCheckpoint() {
    if (localResetGuard || localConflictGuard) return;
    const controller = cloudController;
    if (controller && accountUid) void controller.sync({ checkpoint: true, after: saveQueue }).catch(() => {});
  }
  window.addEventListener('pagehide', saveCloudCheckpoint);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') saveCloudCheckpoint();
  });
  document.querySelectorAll('.close-dialog').forEach(button => button.addEventListener('click', () => button.closest('dialog').close()));
  document.querySelectorAll('dialog').forEach(dialog => {
    dialog.addEventListener('close', renderSaveNotice);
    // A tap on the dimmed backdrop, outside the dialog's box, closes it. Both the
    // press and the release must be outside, so dragging out of the dialog doesn't.
    const outside = event => {
      const box = dialog.getBoundingClientRect();
      return event.target === dialog && (event.clientX < box.left || event.clientX > box.right ||
        event.clientY < box.top || event.clientY > box.bottom);
    };
    let pressedOutside = false;
    dialog.addEventListener('pointerdown', event => { pressedOutside = outside(event); });
    dialog.addEventListener('click', event => {
      if (dialog.id === 'local-conflict-dialog') return;
      if (dialog.id === 'delete-local-dialog' && (deletingLocalData || localResetGuard)) return;
      if (dialog.id === 'category-unlock-dialog' && purchasingCategory) return;
      if (pressedOutside && outside(event)) dialog.close();
      pressedOutside = false;
    });
  });
  $('retry-button').addEventListener('click', () => { $('load-error').hidden = true; placeBanners(); retryAction(); });
  // Prevent rapid iOS double-tap zoom; grid gestures already use touch-action:none.
  let previousTouch = 0;
  document.addEventListener('touchend', event => {
    const now = Date.now();
    if (now - previousTouch < 280 && !event.target.closest('button, a, input, textarea') && event.cancelable) event.preventDefault();
    previousTouch = now;
  }, { passive: false });

  function showReplacementNotice() {
    const notice = $('replacement-notice');
    let dismissed = false;
    try { dismissed = localStorage.getItem('wordSearch.replacementNotice.v1') === Journey.RESET_EPOCH; } catch { /* Visible for this session. */ }
    notice.hidden = dismissed;
  }
  $('replacement-notice-dismiss').addEventListener('click', () => {
    $('replacement-notice').hidden = true;
    try { localStorage.setItem('wordSearch.replacementNotice.v1', Journey.RESET_EPOCH); } catch { /* Dismissed for this page. */ }
  });

  async function boot() {
    const request = ++loadNumber;
    $('load-error').hidden = true;
    $('game-layout').setAttribute('aria-busy', 'true');
    try {
      if (!Engine) throw problem('engine');
      await window.WordSearchStore.prepareReplacement();
      const nextLibrary = validateManifest(await readJSON('seeds/manifest.json'));
      if (request !== loadNumber) return;
      if (!nextLibrary.length) throw problem('empty');
      library = nextLibrary;
      catalog = Journey.catalog(library, window.WordSearchProgression);
      if (localResetGuard) return;
      // Only fresh replacement state participates in progression.
      const exists = await refreshSave();
      if (request !== loadNumber) return;
      if (!exists || Journey.initializeProgression(Journey.normalizeState(saved), catalog)) {
        try { await updateSave(() => {}); }
        catch (error) {
          // A refused save must not stop Home from opening.
          if (!error?.saveFailure) throw error;
        }
        if (request !== loadNumber) return;
      }
      renderLibrary(); renderBonus(); showScreen('home');
      showReplacementNotice();
      // Old storage cleanup is optional and must never delay Play or Resume.
      if (databaseReady && !accountUid) void window.WordSearchStore.removeLegacy?.().catch(() => {});
      // The game always opens on Home. Older releases put ?seed= in the address;
      // remove it so a bookmark doesn't suggest otherwise.
      const url = new URL(location.href);
      if (url.searchParams.has('seed')) {
        url.searchParams.delete('seed');
        try { history.replaceState(null, '', url); } catch { /* file viewers may reject history changes */ }
      }
      saveInitialized = true;
      if (cloudEnabled()) void selectAccount(latestAccount);
    } catch (error) {
      // Any failure to load the puzzle list is about the list, not a round.
      if (request === loadNumber) showError(error?.legacyBalanceUnavailable ? 'savedBalance'
        : ['offline', 'engine', 'empty'].includes(error?.kind) ? error.kind : 'library', bootRetry, error);
    } finally { if (request === loadNumber) $('game-layout').setAttribute('aria-busy', 'false'); }
  }
  // Read-only snapshot for repeatable browser verification.
  window.WordSearch = Object.freeze({ state: () => ({ id: puzzle?.id || null, rows: puzzle?.rows || null, cols: puzzle?.cols || null,
    found: [...found], foundBonus: [...foundBonus], total: puzzle?.words.length || 0,
    complete: !!puzzle && found.size === puzzle.words.length, selected: selected.map(cell => ({ ...cell })),
    chest: Journey.chestProgress(saved, puzzle), points: Journey.chestProgress(saved, puzzle).found,
    gems: saved.wallet.gems, screen, activeDifficulty: saved.activeDifficulty, ready: !!catalog,
    progressionConfigured: !!catalog?.configured, accountStatus, saveMode,
    accountUid, cloudStatus, cloudReady, saveScope: 'device' }) });
  scheduleFit();
  renderRoundBackground();
  try {
    const reset = JSON.parse(localStorage.getItem(window.WordSearchStore?.resetKey || 'wordSearch.localReset.v5') || 'null');
    if (reset && ['clearing', 'failed'].includes(reset.phase)) handleLocalReset({ ...reset, external: true, recovery: true });
  } catch { /* Refused storage still permits ordinary memory play. */ }
  boot();
})();
