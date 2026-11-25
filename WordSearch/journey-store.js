(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) module.exports = factory;
  else {
    // Some privacy settings throw from the indexedDB getter itself. Treat that
    // like missing storage so the game can fall back instead of failing to boot.
    let indexedDB = null;
    try { indexedDB = root.indexedDB; } catch { /* Unavailable storage. */ }
    root.WordSearchStore = factory(indexedDB, root.WordSearchJourney);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (indexedDB, Journey, options) {
  'use strict';
  options ||= {};

  const GUEST_KEY = 'wordSearch.v5';
  const MIGRATION_KEY = 'wordSearch.replacementReset.v1';
  const FALLBACK_KEY = 'wordSearch.storage.fallback.v5';
  const FALLBACK_BASE_KEY = 'wordSearch.storage.fallbackBase.v5';
  const RESET_KEY = 'wordSearch.localReset.v5';
  const OPEN_TIMEOUT_MS = 5000;
  const TRANSACTION_TIMEOUT_MS = options.transactionTimeoutMs || 5000;
  const clone = value => JSON.parse(JSON.stringify(value));
  let lastState = null, lastExists = false, fallbackActive = false, currentMode = 'device';
  let fallbackBase = null, fallbackMirrorBase = null, queue = Promise.resolve();
  let replacementMemoryOnly = false;
  let localConflict = null;
  const storage = () => {
    try { return Object.hasOwn(options, 'storage') ? options.storage : globalThis.localStorage; }
    catch { return null; }
  };
  // Account checks can clear this hint while the first database read is pending.
  // Only that previously active account may supply a pre-shared device balance.
  let legacyAccountName = null;
  try {
    const local = storage(), uid = local?.getItem('wordSearch.lastAccount.v1');
    if (uid && local.getItem('wordSearch.shared.local.v1') !== '1') legacyAccountName = accountKey(uid);
  } catch { /* No usable account migration hint. */ }
  function resetMarker() {
    try {
      const marker = JSON.parse(storage()?.getItem(RESET_KEY) || 'null');
      return marker && typeof marker.generation === 'string' ? marker : null;
    } catch { return null; }
  }
  let observedReset = resetMarker();
  function resetError(message = 'Local data was deleted in another tab. Reload before saving again.') {
    return Object.assign(new Error(message), { name: 'LocalResetError', localReset: true });
  }
  function observeReset(marker = resetMarker(), external = true) {
    if (JSON.stringify(marker) === JSON.stringify(observedReset)) return;
    observedReset = marker;
    lastState = null; lastExists = false; fallbackActive = false; fallbackBase = null; fallbackMirrorBase = null; localConflict = null;
    if (!marker) return;
    const detail = { generation: marker.generation, phase: marker.phase, external };
    options.onReset?.(detail);
    if (typeof window !== 'undefined' && typeof CustomEvent === 'function') {
      window.dispatchEvent(new CustomEvent('wordsearch-local-reset', { detail }));
    }
  }
  function assertGeneration(generation) {
    const marker = resetMarker();
    observeReset(marker);
    if ((marker?.generation || null) !== generation || (marker && marker.phase !== 'complete')) throw resetError();
  }
  if (typeof window !== 'undefined') {
    window.addEventListener('storage', event => {
      if (event.key === RESET_KEY) observeReset();
    });
  }
  function report(mode, error) {
    currentMode = mode;
    options.onMode?.({ mode, error });
    if (typeof window !== 'undefined' && typeof CustomEvent === 'function') {
      window.dispatchEvent(new CustomEvent('wordsearch-storage-state', { detail: { mode, error } }));
    }
  }

  function accountKey(uid) {
    if (typeof uid !== 'string' || !uid || uid.length > 128 || /[\u0000-\u001f\u007f]/.test(uid)) {
      throw new TypeError('A valid account ID is required for account progress.');
    }
    return `wordSearch.account.v4.${encodeURIComponent(uid)}`;
  }

  function failure(cause, safeToFallback) {
    const error = new Error(cause?.message || 'Progress could not be saved on this device.');
    error.name = cause?.name || 'StorageError';
    if (cause?.code) error.code = cause.code;
    error.safeToFallback = safeToFallback;
    if (cause?.newerSave) error.newerSave = true;
    if (cause?.mutationError) error.mutationError = true;
    if (cause?.localReset) error.localReset = true;
    if (cause?.localConflict) error.localConflict = true;
    if (cause?.conflict) error.conflict = clone(cause.conflict);
    if (cause?.attemptedState) error.attemptedState = cause.attemptedState;
    if (cause?.attemptedBase) error.attemptedBase = cause.attemptedBase;
    if (cause && Object.hasOwn(cause, 'attemptedResult')) error.attemptedResult = cause.attemptedResult;
    return error;
  }

  function newerSave() {
    return Object.assign(new Error('A newer version of the game saved this progress.'),
      { name: 'NewerSaveError', newerSave: true });
  }

  function conflictError() {
    return Object.assign(new Error('Another tab changed local progress while storage was unavailable. Saving is paused; keep recovery copies before reloading the saved progress.'),
      { name: 'LocalConflictError', localConflict: true, safeToFallback: false, conflict: clone(localConflict) });
  }
  function latchConflict(memoryState, attemptedState, deviceState, deviceSource = 'indexedDB') {
    // Keep both branches intact. This is not an ordinary storage failure: a
    // mirror write here would grant stale memory authority over the newer save.
    localConflict ||= {
      memoryState: clone(memoryState), attemptedState: clone(attemptedState),
      deviceState: clone(deviceState), baseState: clone(fallbackBase), deviceSource
    };
    remember(localConflict.memoryState);
    return conflictError();
  }

  function open(name = GUEST_KEY, version = 1) {
    return new Promise((resolve, reject) => {
      if (!indexedDB?.open) {
        reject(failure(new Error('IndexedDB is unavailable.'), true));
        return;
      }
      let request, settled = false, timer = 0;
      const refuse = cause => {
        if (settled) return;
        settled = true; clearTimeout(timer);
        reject(failure(cause, true));
      };
      try { request = version === null ? indexedDB.open(name) : indexedDB.open(name, version); }
      catch (error) { refuse(error); return; }
      // Some browsers never answer an open. Don't let every save and screen wait on it.
      timer = setTimeout(() => refuse(new Error('Progress storage did not respond.')), OPEN_TIMEOUT_MS);
      request.onupgradeneeded = () => {
        try {
          if (!request.result.objectStoreNames.contains('state')) request.result.createObjectStore('state');
        } catch (error) {
          try { request.transaction.abort(); } catch { /* Already aborted. */ }
          refuse(error);
        }
      };
      request.onerror = () => {
        // A later release upgraded the database. This page must not save elsewhere.
        if (request.error?.name === 'VersionError' && !settled) {
          settled = true; clearTimeout(timer);
          reject(failure(newerSave(), false));
          return;
        }
        refuse(request.error);
      };
      request.onblocked = () => refuse(new Error('Progress storage is blocked by another version of the game.'));
      request.onsuccess = () => {
        const database = request.result;
        if (settled) { database.close(); return; }
        settled = true; clearTimeout(timer);
        database.onversionchange = () => database.close();
        resolve(database);
      };
    });
  }

  async function databaseUpdate(change, fallbackState, name = GUEST_KEY, generation = observedReset?.generation || null) {
    const database = await open(name);
    return new Promise((resolve, reject) => {
      let transaction, state, result, operationError, attemptedBase, mutationCompleted = false, settled = false, timer;
      try { transaction = database.transaction('state', 'readwrite'); }
      catch (error) { database.close(); reject(failure(error, false)); return; }
      const finish = (error, abort = false) => {
        if (settled) return;
        settled = true; clearTimeout(timer);
        // Abort synchronously before releasing the queue. A browser can stop
        // delivering transaction events, including the abort event itself.
        if (abort) { try { transaction.abort(); } catch { /* It may have already committed. */ } }
        database.close();
        if (!error) { resolve({ state, result }); return; }
        const cause = failure(error, false);
        // A commit may have completed without its event reaching us. Preserve
        // the exact candidate and result rather than invoking change again.
        if (mutationCompleted && state) {
          cause.attemptedState = state; cause.attemptedBase = attemptedBase; cause.attemptedResult = result;
        }
        reject(cause);
      };
      transaction.oncomplete = () => finish(operationError);
      transaction.onabort = () => finish(operationError || transaction.error || new Error('Progress storage aborted the save.'));
      timer = setTimeout(() => finish(operationError || Object.assign(new Error('Progress storage did not finish saving.'), { name: 'TimeoutError' }), true), TRANSACTION_TIMEOUT_MS);
      // Request failures normally settle through onabort; the deadline also
      // handles a browser that never delivers that event.
      transaction.onerror = () => {};
      try {
        const store = transaction.objectStore('state');
        const request = store.get('current');
        request.onsuccess = () => {
          if (settled) return;
          try {
            if (name === GUEST_KEY) assertGeneration(generation);
            // Never replace a save this release cannot fully read.
            const current = request.result === undefined ? fallbackState : request.result;
            if (Journey.isNewer(current)) throw newerSave();
            state = Journey.normalizeState(current);
            attemptedBase = clone(state);
            try { result = change(state); }
            catch (error) { throw Object.assign(failure(error, false), { mutationError: true }); }
            if (result && typeof result.then === 'function') throw Object.assign(new TypeError('Save mutations must be synchronous.'), { mutationError: true });
            mutationCompleted = true;
            if (name === GUEST_KEY) assertGeneration(generation);
            store.put(state, 'current');
          } catch (error) {
            operationError = error;
            try { transaction.abort(); }
            catch { finish(error); }
          }
        };
      } catch (error) {
        operationError = error;
        try { transaction.abort(); }
        catch { finish(error); }
      }
    });
  }

  async function databaseRead(name = GUEST_KEY) {
    const database = await open(name);
    return new Promise((resolve, reject) => {
      let transaction, value, operationError, settled = false, timer;
      try { transaction = database.transaction('state', 'readonly'); }
      catch (error) { database.close(); reject(failure(error, false)); return; }
      const finish = (error, abort = false) => {
        if (settled) return;
        settled = true; clearTimeout(timer);
        if (abort) { try { transaction.abort(); } catch { /* Already finished. */ } }
        database.close();
        if (!error) { resolve(value); return; }
        const cause = failure(value?.newer ? newerSave() : error, false);
        // A successful get remains a useful fallback even if the surrounding
        // read-only transaction never reports completion.
        if (value) cause.readRecord = value;
        reject(cause);
      };
      transaction.oncomplete = () => finish(operationError);
      transaction.onabort = () => finish(operationError || transaction.error || new Error('Progress storage aborted the read.'));
      timer = setTimeout(() => finish(operationError || Object.assign(new Error('Progress storage did not finish reading.'), { name: 'TimeoutError' }), true), TRANSACTION_TIMEOUT_MS);
      transaction.onerror = () => {};
      try {
        const request = transaction.objectStore('state').get('current');
        request.onsuccess = () => {
          if (settled) return;
          try {
            const exists = request.result !== undefined;
            value = { exists, rawState: request.result, newer: Journey.isNewer(request.result),
              state: Journey.normalizeState(exists ? request.result : undefined) };
          } catch (error) { operationError = error; finish(error, true); }
        };
      } catch (error) {
        operationError = error;
        try { transaction.abort(); }
        catch { finish(error); }
      }
    });
  }

  function readMirror(name = GUEST_KEY) {
    const raw = storage()?.getItem(name);
    if (!raw) return { exists: false, newer: false, state: Journey.createState() };
    const parsed = JSON.parse(raw);
    return { exists: true, newer: Journey.isNewer(parsed), state: Journey.normalizeState(parsed) };
  }
  function writeMirror(state) {
    const local = storage();
    if (!local) return false;
    const previous = local.getItem(GUEST_KEY);
    if (previous && Journey.isNewer(JSON.parse(previous))) throw newerSave();
    // A fallback mirror can be newer than IndexedDB across a full reload. Keep
    // that authority explicit so yesterday's database cannot undo today's play.
    if (fallbackActive) {
      // A boolean flag alone cannot prove the database is still stale: another
      // tab may commit successfully but fail to refresh this mirror.
      local.setItem(FALLBACK_BASE_KEY, JSON.stringify({ version: 1, baseState: fallbackBase, mirrorState: state }));
      local.setItem(FALLBACK_KEY, '1');
    } else {
      local.removeItem(FALLBACK_KEY);
      local.removeItem(FALLBACK_BASE_KEY);
    }
    local.setItem(GUEST_KEY, JSON.stringify(state));
    return true;
  }
  function mirrorIsAuthority() {
    try { return storage()?.getItem(FALLBACK_KEY) === '1'; } catch { return false; }
  }
  function mirrorBase(state) {
    try {
      const record = JSON.parse(storage()?.getItem(FALLBACK_BASE_KEY) || 'null');
      if (record?.version === 1 && record.baseState && !Journey.isNewer(record.baseState) &&
          JSON.stringify(record.mirrorState) === JSON.stringify(state)) return Journey.normalizeState(record.baseState);
    } catch { /* Old, inaccessible or incomplete provenance is not authority. */ }
    return null;
  }
  function remember(state, exists = true) {
    lastState = clone(state); lastExists = exists;
  }
  function memoryRecord() {
    return { exists: lastExists, newer: false, state: clone(lastState || Journey.createState()), mode: currentMode,
      ...(localConflict ? { localConflict: true, conflict: clone(localConflict) } : {}) };
  }
  async function read(name = GUEST_KEY) {
    if (name !== GUEST_KEY) return databaseRead(name);
    await queue;
    observeReset();
    const generation = observedReset?.generation || null;
    if (localConflict || (observedReset && observedReset.phase !== 'complete')) return memoryRecord();
    let mirror;
    try { mirror = readMirror(); } catch { /* IndexedDB may still work. */ }
    if (mirror?.newer) return { ...mirror, mode: 'device' };
    if (!fallbackActive && mirror?.exists && mirrorIsAuthority()) {
      remember(mirror.state); fallbackActive = true; fallbackBase = mirrorBase(mirror.state);
      report('device');
      return memoryRecord();
    }
    if (fallbackActive) {
      // With a working mirror, other tabs share that persisted snapshot too.
      if (currentMode === 'device' && mirror?.exists) {
        remember(mirror.state);
        if (mirrorIsAuthority()) fallbackBase = mirrorBase(mirror.state);
      }
      return memoryRecord();
    }
    try {
      const record = await databaseRead();
      assertGeneration(generation);
      if (record.newer) return { ...record, mode: 'device' };
      if (record.exists) remember(record.state);
      else if (mirror?.exists) remember(mirror.state);
      else remember(Journey.createState(), false);
      report('device');
      return memoryRecord();
    } catch (error) {
      if (error.localReset) return read();
      if (error.newerSave) throw error;
      try { assertGeneration(generation); } catch (reset) { if (reset.localReset) return read(); throw reset; }
      if (error.readRecord?.exists) remember(error.readRecord.state);
      else if (!lastState) remember(mirror?.state || Journey.createState(), !!mirror?.exists);
      fallbackActive = true;
      fallbackBase = clone(lastState);
      fallbackMirrorBase = mirror?.exists ? clone(mirror.state) : null;
      if (!error.readRecord?.exists && mirror?.exists && JSON.stringify(mirror.state) !== JSON.stringify(lastState)) {
        const conflict = latchConflict(lastState, lastState, mirror.state, 'localStorage');
        report('conflict', conflict);
        return memoryRecord();
      }
      // A stale mirror must not replace a newer value received before the
      // read stalled. The next update will persist that recovered snapshot.
      report(mirror?.exists && JSON.stringify(mirror.state) === JSON.stringify(lastState) ? 'device' : 'memory', error);
      return memoryRecord();
    }
  }
  function applyInMemory(change, base) {
    const state = Journey.normalizeState(base);
    const result = change(state);
    if (result && typeof result.then === 'function') throw new TypeError('Save mutations must be synchronous.');
    return { state, result };
  }
  async function performUpdate(change, fallbackState, generation) {
    assertGeneration(generation);
    // Do not even invoke later mutations (including account writes or detach)
    // until the player explicitly reloads or clears local data.
    if (localConflict) throw conflictError();
    if (replacementMemoryOnly) {
      // An inaccessible original balance must not be replaced if browser
      // storage becomes writable partway through this memory-only session.
      const outcome = applyInMemory(change, lastState || fallbackState || Journey.createState());
      remember(outcome.state); report('memory');
      return { ...outcome, mode: currentMode };
    }
    let mirror;
    try { mirror = readMirror(); } catch { /* An inaccessible mirror does not block play. */ }
    if (mirror?.newer) throw failure(newerSave(), false);
    if (!fallbackActive && mirror?.exists && mirrorIsAuthority()) {
      remember(mirror.state); fallbackActive = true; fallbackBase = mirrorBase(mirror.state); currentMode = 'device';
    }
    const base = (fallbackActive && currentMode === 'device' && mirror?.exists ? mirror.state : lastState) ||
      (mirror?.exists ? mirror.state : fallbackState) || Journey.createState();
    if (fallbackActive && currentMode === 'device') {
      fallbackMirrorBase = mirror?.exists ? clone(mirror.state) : null;
      if (mirror?.exists && mirrorIsAuthority()) fallbackBase = mirrorBase(mirror.state);
    }
    let outcome, storageFailure;
    if (!fallbackActive) {
      try { outcome = await databaseUpdate(change, base, GUEST_KEY, generation); }
      catch (error) {
        if (error.newerSave || error.mutationError || error.localReset || error.localConflict) throw error;
        assertGeneration(generation);
        storageFailure = error;
        fallbackActive = true;
        fallbackBase = clone(error.attemptedBase || base);
        fallbackMirrorBase = mirror?.exists ? clone(mirror.state) : null;
        outcome = error.attemptedState
          ? { state: error.attemptedState, result: error.attemptedResult }
          : applyInMemory(change, base);
        // A failed first database access is not evidence that this tab's last
        // displayed state is newer than another tab's persisted mirror.
        if (!error.attemptedState && mirror?.exists &&
            JSON.stringify(mirror.state) !== JSON.stringify(base) &&
            JSON.stringify(mirror.state) !== JSON.stringify(outcome.state)) {
          const conflict = latchConflict(base, outcome.state, mirror.state, 'localStorage');
          report('conflict', conflict);
          throw conflict;
        }
      }
    } else {
      // Never reread a stale disk snapshot over newer memory-only progress.
      outcome = applyInMemory(change, base);
      try {
        // Recovery of localStorage can precede IndexedDB recovery. A changed
        // mirror is another persisted branch, not permission to publish this
        // page's stale memory even when opening the database still fails.
        const mirrored = mirror?.exists ? JSON.stringify(mirror.state) : null;
        if (currentMode === 'memory' && mirrored &&
            ![fallbackMirrorBase, fallbackBase, base, outcome.state].some(state => JSON.stringify(state) === mirrored)) {
          throw latchConflict(base, outcome.state, mirror.state, 'localStorage');
        }
        await databaseUpdate(current => {
          const persisted = JSON.stringify(current);
          if (persisted !== JSON.stringify(fallbackBase) && persisted !== JSON.stringify(base) && persisted !== JSON.stringify(outcome.state)) {
            throw latchConflict(base, outcome.state, current);
          }
          for (const key of Object.keys(current)) delete current[key];
          Object.assign(current, clone(outcome.state));
        }, fallbackBase || Journey.createState(), GUEST_KEY, generation);
        fallbackActive = false;
        fallbackBase = null;
        fallbackMirrorBase = null;
      } catch (error) {
        if (error.localConflict) {
          report('conflict', error);
          throw error;
        }
        if (error.newerSave || error.localReset) throw error;
        storageFailure = error;
      }
    }
    assertGeneration(generation);
    remember(outcome.state);
    let mirrorSaved = false;
    try { mirrorSaved = writeMirror(outcome.state); }
    catch (error) { if (error.newerSave) throw error; storageFailure ||= error; }
    report(!fallbackActive || mirrorSaved ? 'device' : 'memory', storageFailure);
    return { ...outcome, mode: currentMode };
  }
  function update(change, fallbackState) {
    // Capture the generation before joining any queue. A delayed old callback
    // must never become a fresh mutation merely because deletion finished first.
    const generation = observedReset?.generation || null;
    try { assertGeneration(generation); } catch (error) { return Promise.reject(error); }
    // A callback submitted while the dialog is open stays rejected even if an
    // explicit device-save selection ahead of it later releases the latch.
    if (localConflict) return Promise.reject(conflictError());
    const run = () => {
      const locks = Object.hasOwn(options, 'locks') ? options.locks : globalThis.navigator?.locks;
      if (!locks?.request) return performUpdate(change, fallbackState, generation);
      let entered = false;
      return locks.request(`${GUEST_KEY}:store`, () => { entered = true; return performUpdate(change, fallbackState, generation); })
        .catch(error => { if (!entered && error?.name === 'SecurityError') return performUpdate(change, fallbackState, generation); throw error; });
    };
    const pending = queue.then(run, run);
    queue = pending.catch(() => {});
    return pending;
  }

  function useDeviceSave() {
    // Explicit player choice only. Never use the frozen conflict snapshot:
    // another tab may have made more progress since the dialog opened.
    const generation = observedReset?.generation || null;
    const run = () => withLock(`${GUEST_KEY}:store`, async () => {
      assertGeneration(generation);
      if (!localConflict) throw new Error('There is no local-save conflict to resolve.');
      const record = await databaseRead();
      assertGeneration(generation);
      if (record.newer) throw newerSave();
      const mirror = readMirror();
      if (mirror.newer) throw newerSave();
      const baseline = mirror.exists && mirrorIsAuthority() ? mirrorBase(mirror.state) : null;
      const provenMirror = baseline && JSON.stringify(baseline) === JSON.stringify(record.state);
      if (!record.exists && !provenMirror) throw new Error('The saved device progress could not be verified. Keep the recovery copies and try again.');
      const state = provenMirror ? mirror.state : record.state;
      if (!provenMirror) {
        const local = storage();
        if (!local) throw new Error('The device save could not be selected while local storage is unavailable.');
        // Write the selected full snapshot before retiring stale authority.
        // Failure at any point keeps the recovery latch and both original
        // snapshots; no database or cloud progress is overwritten here.
        local.setItem(GUEST_KEY, JSON.stringify(state));
        local.removeItem(FALLBACK_KEY);
        local.removeItem(FALLBACK_BASE_KEY);
        if (local.getItem(GUEST_KEY) !== JSON.stringify(state) || local.getItem(FALLBACK_KEY) !== null ||
            local.getItem(FALLBACK_BASE_KEY) !== null) throw new Error('The selected device save could not be verified.');
      }
      assertGeneration(generation);
      remember(state);
      fallbackActive = !!provenMirror;
      fallbackBase = provenMirror ? clone(baseline) : null;
      fallbackMirrorBase = provenMirror ? clone(state) : null;
      localConflict = null;
      report('device');
      return memoryRecord();
    });
    const pending = queue.then(run, run);
    queue = pending.catch(() => {});
    return pending;
  }

  function balanceUnavailable(cause) {
    return Object.assign(new Error('The previous gem balance could not be read. Please try again.'),
      { legacyBalanceUnavailable: true, cause });
  }
  function rawMirror(name) {
    const local = storage();
    if (!local) return { available: false };
    let raw;
    try { raw = local.getItem(name); }
    catch (error) { return { available: false, error }; }
    if (raw === null) return { available: true, exists: false };
    try { return { available: true, exists: true, rawState: JSON.parse(raw) }; }
    catch (error) { return { available: true, error }; }
  }
  async function replacementSource(name) {
    const mirror = rawMirror(name);
    if (Journey.isNewer(mirror.rawState)) throw newerSave();
    let authority = false;
    try { authority = name === 'wordSearch.v4' && storage()?.getItem('wordSearch.storage.fallback.v1') === '1'; }
    catch { /* The normal database-first policy still applies. */ }
    if (authority && mirror.error) throw balanceUnavailable(mirror.error);
    if (authority && mirror.exists) return { ...mirror, name, captured: true };
    let database, error;
    if (indexedDB?.open) {
      try { database = await databaseRead(name); }
      catch (cause) {
        if (cause.newerSave) throw cause;
        // A get that succeeded before the transaction timed out still read
        // the authoritative snapshot, including an explicitly empty store.
        database = cause.readRecord; error = database ? null : cause;
      }
    }
    if (database?.newer) throw newerSave();
    if (database?.exists) return { ...database, name, captured: true };
    // A readable but non-authoritative mirror may be stale. Persisting it as
    // v5 would prevent the next launch from ever retrying the original balance.
    if (error) throw balanceUnavailable(error);
    if (mirror.exists) return { ...mirror, name, captured: true };
    if (mirror.error || (!database && !mirror.available)) throw balanceUnavailable(mirror.error);
    return { exists: false, name, captured: true };
  }
  let replacementPreparation = null;
  function prepareReplacement() {
    replacementPreparation ||= (async () => {
      const current = await read();
      if (current.newer) throw newerSave();
      const captured = new Set();
      if (!current.exists) {
        let source;
        try {
          // An unresolved current-generation read is not proof of a new device.
          if (indexedDB?.open && current.mode === 'memory') throw balanceUnavailable();
          source = await replacementSource('wordSearch.v4');
          if (source.captured) captured.add(source.name);
          if (!source.exists && legacyAccountName) {
            source = await replacementSource(legacyAccountName);
            if (source.captured) captured.add(source.name);
          }
          if (source.exists && source.rawState?.version !== 4) throw balanceUnavailable();
          // A missing API (including a denied indexedDB getter) cannot prove
          // that an older database has no balance. Never persist a guessed zero.
          if (!source.exists && !indexedDB?.open) replacementMemoryOnly = true;
        } catch (error) {
          if (error.newerSave) throw error;
          // Privacy modes can deny both backends completely. Allow play, but
          // keep it isolated from every persistent save for this page's life.
          if (current.mode !== 'memory' || rawMirror('wordSearch.v4').available) throw error;
          replacementMemoryOnly = true;
        }
        const blank = Journey.resetCampaign(source?.rawState);
        await update(state => {
          if (state.revision || Object.keys(state.maps).length || state._cloud) return;
          Object.assign(state, blank);
        }, blank);
      }
      // Do not discard an original balance before a persistent fresh save exists.
      if (currentMode !== 'device') return read();
      // Other account balances and unreadable originals remain recoverable.
      // A later v5 launch must not assume those balances were already captured.
      const names = new Set(['wordSearch.v1', 'wordSearch.v2', 'wordSearch.v3', ...captured]);
      try {
        const local = storage(), keys = [];
        for (let i = 0; i < (local?.length || 0); i++) {
          const key = local.key(i);
          if (names.has(key) || (captured.has('wordSearch.v4') &&
              ['wordSearch.shared.local.v1', 'wordSearch.storage.fallback.v1', 'wordSearch.checkpoint.v1'].includes(key))) keys.push(key);
        }
        for (const key of keys) local.removeItem(key);
        local?.setItem(MIGRATION_KEY, Journey.RESET_EPOCH);
      } catch { /* Cleanup is best effort; old data is never read by gameplay. */ }
      // Never let an old tab's open database block the fresh campaign.
      void Promise.allSettled([...names].map(deleteDatabase));
      return read();
    })().catch(error => {
      // The Retry button reuses this store instance after a transient failure.
      replacementPreparation = null;
      if (!lastExists) { fallbackActive = false; fallbackBase = null; lastState = null; }
      throw error;
    });
    return replacementPreparation;
  }
  function withLock(name, callback) {
    const locks = Object.hasOwn(options, 'locks') ? options.locks : globalThis.navigator?.locks;
    if (!locks?.request) return callback();
    let entered = false;
    return locks.request(name, () => { entered = true; return callback(); })
      .catch(error => { if (!entered && error?.name === 'SecurityError') return callback(); throw error; });
  }
  function assertResetOwner(generation) {
    if (resetMarker()?.generation !== generation) throw resetError('A newer local-data reset is already in progress.');
  }
  async function replaceWithBlank(state, generation) {
    let database = await open(GUEST_KEY, null);
    // A future database version must be retired, not merely emptied: ordinary
    // gameplay opens v1 and would otherwise remain locked behind VersionError.
    if (database.version > 1) {
      database.close();
      await deleteDatabase(GUEST_KEY);
      assertResetOwner(generation);
      database = await open();
    }
    return new Promise((resolve, reject) => {
      let transaction, operationError;
      try {
        assertResetOwner(generation);
        const names = Array.from(database.objectStoreNames);
        transaction = database.transaction(names, 'readwrite');
        transaction.oncomplete = () => { database.close(); resolve(); };
        transaction.onabort = () => { database.close(); reject(operationError || transaction.error || new Error('The saved progress could not be cleared.')); };
        transaction.onerror = () => {};
        // Explicit deletion also clears records introduced by newer releases.
        for (const name of names) transaction.objectStore(name).clear();
        transaction.objectStore('state').put(state, 'current');
      } catch (error) {
        operationError = error;
        if (transaction) {
          try { transaction.abort(); } catch { database.close(); reject(error); }
        } else { database.close(); reject(error); }
      }
    });
  }
  function deleteDatabase(name) {
    return new Promise((resolve, reject) => {
      let request, settled = false;
      const finish = error => {
        if (settled) return;
        settled = true; clearTimeout(timer);
        if (error) reject(error); else resolve();
      };
      const timer = setTimeout(() => finish(new Error(`Close other WordSearch tabs before deleting ${name}.`)), options.resetTimeoutMs || OPEN_TIMEOUT_MS);
      try {
        if (!indexedDB?.deleteDatabase) throw new Error('Saved databases are unavailable and could not be cleared.');
        request = indexedDB.deleteDatabase(name);
      } catch (error) { finish(error); return; }
      request.onsuccess = () => finish();
      request.onerror = () => finish(request.error || new Error(`Could not delete ${name}.`));
      // A blocked request may still finish once a legacy tab closes. Wait for
      // that success, but never report a completed deletion while it is blocked.
      request.onblocked = () => {};
    });
  }
  async function performClear(generation) {
    assertResetOwner(generation);
    const local = storage(), state = Journey.createState(), errors = [];
    const names = new Set(['wordSearch.v1', 'wordSearch.v2', 'wordSearch.v3', 'wordSearch.v4']);
    const keys = [];
    try {
      for (let index = 0; index < local.length; index++) {
        const key = local.key(index);
        if (key?.startsWith('wordSearch.') && key !== RESET_KEY) keys.push(key);
        if (key?.startsWith('wordSearch.account.v4.')) names.add(key);
      }
    } catch (error) { errors.push(error); }
    try {
      if (!indexedDB?.databases) throw new Error('Saved databases could not be listed for complete deletion.');
      for (const database of await indexedDB.databases()) {
        if (database.name?.startsWith('wordSearch.account.v4.')) names.add(database.name);
      }
    } catch (error) { errors.push(error); }
    assertResetOwner(generation);
    for (const key of keys) {
      try { local.removeItem(key); if (local.getItem(key) !== null) throw new Error(`Could not delete ${key}.`); }
      catch (error) { errors.push(error); }
    }
    try { await replaceWithBlank(state, generation); } catch (error) { errors.push(error); }
    const deleted = await Promise.allSettled([...names].map(deleteDatabase));
    for (const result of deleted) if (result.status === 'rejected') errors.push(result.reason);
    assertResetOwner(generation);
    try { local.setItem(GUEST_KEY, JSON.stringify(state)); }
    catch (error) { errors.push(error); }
    if (errors.length) {
      const error = resetError('Some local data could not be deleted. Close other WordSearch tabs and try again.');
      error.resetIncomplete = true; error.causes = errors;
      throw error;
    }
    local.setItem(RESET_KEY, JSON.stringify({ generation, phase: 'complete' }));
    observeReset(resetMarker(), false);
    replacementMemoryOnly = false;
    remember(state); report('device');
    return { ...memoryRecord(), reset: true, generation };
  }
  function clearLocalData() {
    const generation = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const marker = { generation, phase: 'clearing' };
    try {
      const local = storage();
      if (!local) throw new Error('Local storage is unavailable.');
      local.setItem(RESET_KEY, JSON.stringify(marker));
      if (local.getItem(RESET_KEY) !== JSON.stringify(marker)) throw new Error('The deletion marker could not be saved.');
      observeReset(marker, false);
    } catch (cause) {
      const error = resetError('Local storage is unavailable, so complete deletion could not be verified.');
      error.resetIncomplete = true; error.causes = [cause];
      return Promise.reject(error);
    }
    // Take the migration lock before joining the store queue. A migration that
    // already holds it can finish/reject its queued write without a lock cycle.
    return withLock(`${GUEST_KEY}:migration`, () => {
      const run = () => withLock(`${GUEST_KEY}:store`, () => performClear(generation));
      const pending = queue.then(run, run);
      queue = pending.catch(() => {});
      return pending;
    }).catch(error => {
      if (resetMarker()?.generation === generation) {
        try { storage().setItem(RESET_KEY, JSON.stringify({ generation, phase: 'failed' })); } catch { /* Keep the clearing barrier if storage fails. */ }
        observeReset(resetMarker(), false);
      }
      error.resetIncomplete = true;
      throw error;
    });
  }

  // Call only after the new generation has committed. An old open tab may
  // temporarily block deletion, but it cannot write into the isolated v4 store.
  function removeLegacy() {
    return new Promise(resolve => {
      if (!indexedDB?.deleteDatabase) { resolve(false); return; }
      // A queued deletion may emit no events until an earlier blocked request
      // finishes. Cleanup must settle even in that case; the browser can still
      // finish the deletion later when its old connections are closed.
      const finish = removed => { clearTimeout(timeout); resolve(removed); };
      const timeout = setTimeout(() => finish(false), 100);
      let request;
      try { request = indexedDB.deleteDatabase('wordSearch.v3'); }
      catch { finish(false); return; }
      request.onsuccess = () => finish(true);
      request.onerror = () => finish(false);
      request.onblocked = () => finish(false);
    });
  }

  function forAccount(uid) {
    accountKey(uid); // Validate the identity; every player uses the same device save.
    return Object.freeze({
      storageKey: GUEST_KEY,
      read: () => read(),
      update: change => update(change, Journey.createState())
    });
  }

  // Signing out changes cloud ownership, never the local gameplay snapshot.
  async function detach() {
    const outcome = await update(state => { delete state._cloud; }, Journey.createState());
    // A latched/queued conflict must reject before changing the checkpoint too.
    try { storage()?.removeItem('wordSearch.checkpoint.v5'); } catch { /* The former account marker is ignored by other accounts. */ }
    return outcome;
  }

  return Object.freeze({ storageKey: GUEST_KEY, resetKey: RESET_KEY, prepareReplacement, get mode() { return currentMode; },
    get conflict() { return localConflict ? clone(localConflict) : null; }, update, read, useDeviceSave, removeLegacy, forAccount, detach, clearLocalData });
});
