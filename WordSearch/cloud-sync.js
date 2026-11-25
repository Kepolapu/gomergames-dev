(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.WordSearchCloud = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const RESET_EPOCH = 'replacement-v1';
  const STATE_KEYS = ['version', 'resetEpoch', 'revision', 'maps', 'activeDifficulty', 'chest', 'wallet', 'progression'];
  const DIFFICULTIES = ['Easy', 'Medium', 'Hard'];
  const TRACK_KEYS = ['unlockedCategoryIds', 'completedMapIds', 'earnedUnlocks'];
  const MAP_KEYS = ['signature', 'difficulty', 'words', 'bonusWords', 'openedAt', 'updatedRevision', 'wordCount', 'bonusCount', 'complete', 'chestOpened'];
  const WRITE_ID = /^[A-Za-z0-9_-]{16,128}$/;
  const ID = value => typeof value === 'string' && value.length > 0 && value.length <= 180 &&
    !['__proto__', 'constructor', 'prototype'].includes(value);
  const integer = value => Number.isSafeInteger(value) && value >= 0;
  const object = value => value && typeof value === 'object' && !Array.isArray(value);
  const clone = value => JSON.parse(JSON.stringify(value));
  const error = (code, message) => Object.assign(new Error(message), { code });
  function only(value, keys) { return object(value) && Object.keys(value).every(key => keys.includes(key)); }
  function assert(condition, message) { if (!condition) throw error('cloud/invalid-save', message); }

  function serializeProgression(value) {
    assert(only(value, ['version', 'tracks']) && value.version === 1 &&
      only(value.tracks, DIFFICULTIES) && DIFFICULTIES.every(key => Object.hasOwn(value.tracks, key)),
    'Invalid category progression.');
    const tracks = {};
    for (const difficulty of DIFFICULTIES) {
      const track = value.tracks[difficulty];
      assert(only(track, TRACK_KEYS) && integer(track.earnedUnlocks), 'Invalid category progression track.');
      for (const key of ['unlockedCategoryIds', 'completedMapIds']) {
        assert(Array.isArray(track[key]) && track[key].length <= 500 && track[key].every(ID) &&
          new Set(track[key]).size === track[key].length, 'Invalid category progression IDs.');
      }
      tracks[difficulty] = { unlockedCategoryIds: [...track.unlockedCategoryIds],
        completedMapIds: [...track.completedMapIds].sort(), earnedUnlocks: track.earnedUnlocks };
    }
    return { version: 1, tracks };
  }

  function baselineProgression(state, Journey) {
    if (Journey?.progressionBaseline) return serializeProgression(Journey.progressionBaseline(state));
    return { version: 1, tracks: Object.fromEntries(DIFFICULTIES.map(difficulty => [difficulty,
      { unlockedCategoryIds: ['farm-animals'], completedMapIds: [], earnedUnlocks: 0 }])) };
  }

  // Canonical wire data has no local sync journal. Unknown future fields fail
  // closed instead of disappearing during a whole-save upload.
  function serialize(raw, Journey) {
    assert(object(raw) && raw.version === 5 && raw.resetEpoch === RESET_EPOCH, 'This save version cannot be synchronized.');
    assert(only(raw, [...STATE_KEYS, '_cloud']), 'This save has unsupported fields.');
    assert(only(raw.chest, ['points']) && only(raw.wallet, ['gems', 'jade', 'awardedMapIds']), 'This wallet has unsupported fields.');
    const hasProgression = Object.hasOwn(raw, 'progression');
    if (hasProgression) serializeProgression(raw.progression);
    for (const map of Object.values(raw.maps || {})) {
      assert(only(map, MAP_KEYS), 'This map has unsupported fields.');
      assert(map.chestOpened === undefined || typeof map.chestOpened === 'boolean', 'Invalid chest collection status.');
    }
    const state = Journey ? Journey.normalizeState(raw) : clone(raw);
    delete state._cloud;
    assert(integer(state.revision), 'Invalid save revision.');
    assert(['Easy', 'Medium', 'Hard'].includes(state.activeDifficulty), 'Invalid difficulty.');
    assert([0, 25, 50, 75, 100].includes(state.chest.points), 'Invalid chest points.');
    assert(integer(state.wallet.gems) && Array.isArray(state.wallet.awardedMapIds) && state.wallet.awardedMapIds.length <= 500 &&
      state.wallet.awardedMapIds.every(ID), 'Invalid wallet.');
    assert(object(state.maps) && Object.keys(state.maps).length <= 500, 'Too many saved maps.');
    const maps = {};
    for (const id of Object.keys(state.maps).sort()) {
      const map = state.maps[id];
      assert(ID(id) && only(map, MAP_KEYS) && typeof map.signature === 'string' && map.signature.length <= 65536 &&
        ['Easy', 'Medium', 'Hard'].includes(map.difficulty) && typeof map.complete === 'boolean' &&
        ['openedAt', 'updatedRevision', 'wordCount', 'bonusCount'].every(key => integer(map[key])), 'Invalid saved map.');
      for (const key of ['words', 'bonusWords']) assert(Array.isArray(map[key]) && map[key].length <= 512 &&
        map[key].every(word => typeof word === 'string' && /^[A-Z]{1,40}$/.test(word)), 'Invalid saved words.');
      maps[id] = { signature: map.signature, difficulty: map.difficulty, words: [...map.words].sort(),
        bonusWords: [...map.bonusWords].sort(), openedAt: map.openedAt, updatedRevision: map.updatedRevision,
        wordCount: map.wordCount, bonusCount: map.bonusCount, complete: map.complete,
        chestOpened: map.chestOpened === true };
    }
    const result = { version: 5, resetEpoch: RESET_EPOCH, revision: state.revision, maps, activeDifficulty: state.activeDifficulty,
      chest: { points: state.chest.points }, wallet: { gems: state.wallet.gems,
        awardedMapIds: [...state.wallet.awardedMapIds].sort() } };
    // Keep legacy wire snapshots byte-compatible for pending acknowledgements.
    // Effective migration belongs in gameplay comparison, not serialization.
    if (hasProgression) result.progression = serializeProgression(state.progression);
    assert(new TextEncoder().encode(JSON.stringify(result)).byteLength <= 800000, 'This save is too large to synchronize.');
    return result;
  }
  function hasProgress(state) {
    return !!state && (Object.keys(state.maps || {}).length > 0 || state.chest?.points > 0 ||
      state.wallet?.gems > 0 || state.wallet?.jade > 0 || state.wallet?.awardedMapIds?.length > 0 ||
      DIFFICULTIES.some(difficulty => {
        const track = state.progression?.tracks?.[difficulty];
        return track?.earnedUnlocks > 0 || track?.completedMapIds?.length > 0 ||
          track?.unlockedCategoryIds?.some(id => id !== 'farm-animals');
      }));
  }

  // Navigation and visit timestamps are local preferences, not conflicting play.
  // Opening an untouched round likewise must not create a destructive-save prompt.
  function progressFingerprint(raw, Journey) {
    const state = serialize(raw, Journey);
    state.progression ||= baselineProgression(state, Journey);
    // Unlock order controls presentation, but equal entitlements are equal play.
    for (const track of Object.values(state.progression.tracks)) track.unlockedCategoryIds.sort();
    delete state.revision;
    delete state.activeDifficulty;
    for (const [id, map] of Object.entries(state.maps)) {
      if (!map.words.length && !map.bonusWords.length && !map.complete && !map.chestOpened) {
        delete state.maps[id];
        continue;
      }
      delete map.openedAt;
      delete map.updatedRevision;
    }
    return JSON.stringify(state);
  }

  function create({ Journey, store, transport, uid, onStatus = () => {}, onChange = () => {}, allowSync = () => true,
    locks = globalThis.navigator?.locks, storage, retry = {} }) {
    if (!Journey || !store || !transport || typeof uid !== 'string' || !uid) throw new TypeError('Cloud synchronization needs an account and a local store.');
    let active = true, ready = true, flight = null, choice = null, lastStatus = 'checking', resync = false;
    let checkpointRequested = false;
    let checkpointGate = null;
    let retryTimer = null, retryAttempt = 0, retryWanted = false;
    const retryDelays = retry.delaysMs || [2000, 5000, 15000, 30000];
    const setRetryTimer = retry.setTimeout || ((callback, delay) => setTimeout(callback, delay));
    const clearRetryTimer = retry.clearTimeout || (timer => clearTimeout(timer));
    const retryAvailable = retry.canRun || (() => globalThis.document?.visibilityState !== 'hidden' && globalThis.navigator?.onLine !== false);
    const permanentFailure = failure => failure?.localStorage ||
      /invalid-save|permission-denied|unauthenticated|failed-precondition|profile-required/.test(String(failure?.code || ''));
    function cancelRetry(reset = true) {
      if (retryTimer !== null) clearRetryTimer(retryTimer);
      retryTimer = null;
      if (reset) { retryAttempt = 0; retryWanted = false; }
    }
    function scheduleRetry() {
      if (!active || choice || !retryWanted || !allowSync() || !retryAvailable() || retryTimer !== null) return;
      const delay = retryDelays[Math.min(retryAttempt++, retryDelays.length - 1)];
      retryTimer = setRetryTimer(() => {
        retryTimer = null;
        // A suspended/offline page resumes through the existing account and
        // foreground listeners. A retry never creates new checkpoint intent.
        if (active && !choice && allowSync() && retryAvailable()) void sync();
      }, delay);
      retryTimer?.unref?.();
    }
    const checkpointKey = 'wordSearch.checkpoint.v5';
    const checkpointStorage = () => {
      try { return storage === undefined ? globalThis.localStorage : storage; } catch { return null; }
    };
    function checkpointMarker() {
      try {
        const marker = JSON.parse(checkpointStorage()?.getItem(checkpointKey) || 'null');
        return marker?.uid === uid && typeof marker.token === 'string' ? marker : null;
      } catch { return null; }
    }
    function retainCheckpoint() {
      checkpointRequested = true;
      try { checkpointStorage()?.setItem(checkpointKey, JSON.stringify({ uid, token: newID() })); }
      catch { /* The live intent remains; unavailable storage cannot block play. */ }
    }
    function clearCheckpoint(marker) {
      try {
        if (marker && checkpointMarker()?.token === marker.token) checkpointStorage()?.removeItem(checkpointKey);
      } catch { /* Replaying an already persisted checkpoint is harmless. */ }
    }
    const canonical = state => serialize(state, Journey);
    const fingerprint = state => JSON.stringify(canonical(state));
    const sameProgress = (left, right) => progressFingerprint(left, Journey) === progressFingerprint(right, Journey);
    const remoteID = remote => remote?.writeId || '';
    const assertActive = () => { if (!active) throw error('cloud/stopped', 'This account session has ended.'); };
    const assertOnline = () => { assertActive(); if (!allowSync()) throw error('cloud/offline', 'Account verification is required to synchronize.'); };
    function publish(status, detail = {}) {
      if (!active) return;
      lastStatus = status;
      onStatus({ status, ready, ...detail });
    }
    function announce(state) { if (active) onChange(canonical(state)); }
    function meta(state) {
      const value = state?._cloud;
      // This is one shared device snapshot. A previous account's pending write
      // must never become an operation against the newly signed-in account.
      if (!value || value.uid !== uid) return null;
      assert([1, 2].includes(value.version) && typeof value.initialized === 'boolean' && typeof value.dirty === 'boolean' &&
        typeof value.baseWriteId === 'string' && (!value.baseWriteId || WRITE_ID.test(value.baseWriteId)) &&
        (value.version === 1 || typeof value.uploadRequested === 'boolean'), 'Invalid account synchronization journal.');
      if (value.pending) {
        assert(value.initialized && WRITE_ID.test(value.pending.writeId) && typeof value.pending.parentWriteId === 'string' &&
          value.pending.parentWriteId === value.baseWriteId, 'Invalid pending save.');
        serialize(value.pending.state);
      }
      if (value.conflict) {
        assert(['import', 'conflict'].includes(value.conflict.type) && typeof value.conflict.remoteID === 'string' &&
          (!value.conflict.remoteID || WRITE_ID.test(value.conflict.remoteID)), 'Invalid saved progress choice.');
        if (value.conflict.state) serialize(value.conflict.state);
      }
      return value;
    }
    const wantsUpload = metadata => metadata?.version === 1
      ? metadata.dirty && !metadata.pending : metadata?.uploadRequested === true;
    function journal(baseWriteId = '', dirty = true, uploadRequested = false, initialized = true) {
      return { version: 2, uid, initialized, baseWriteId, dirty, uploadRequested, pending: null };
    }
    function editableMeta(state) {
      let value = meta(state);
      if (!value) state._cloud = value = journal('', true, false, false);
      if (value.version === 1) {
        value.uploadRequested = wantsUpload(value);
        value.version = 2;
      }
      return value;
    }
    function token(record) {
      return JSON.stringify({ exists: record.exists, state: canonical(record.state), meta: record.state._cloud || null });
    }
    function storageError(failure) {
      const marked = failure && typeof failure === 'object' ? failure : new Error(String(failure));
      marked.localStorage = true;
      if (marked.localConflict) {
        ready = false; choice = null;
        cancelRetry();
        publish('error', { error: marked });
      }
      return marked;
    }
    async function localUpdate(change) {
      try { return await store.update(change); }
      catch (failure) { throw storageError(failure); }
    }
    async function localRead() {
      assertActive();
      try {
        const record = await store.read();
        assertActive();
        // A split local save is recovery data, never an upload candidate. The
        // player must retain/export it and reload the committed device copy.
        if (record.localConflict) throw Object.assign(error('cloud/local-conflict',
          'Local progress differs between tabs. Saving is paused until you reload.'),
          { name: 'LocalConflictError', localConflict: true, conflict: record.conflict });
        if (record.newer) throw Object.assign(error('cloud/invalid-save', 'A newer game version saved this progress.'), { newerSave: true });
        canonical(record.state);
        meta(record.state);
        return record;
      } catch (failure) { throw storageError(failure); }
    }
    function envelope(raw) {
      if (raw === null) return null;
      assert(object(raw) && [1, 2].includes(raw.schemaVersion) && WRITE_ID.test(raw.writeId) && typeof raw.parentWriteId === 'string' &&
        (!raw.parentWriteId || WRITE_ID.test(raw.parentWriteId)), 'Invalid cloud save.');
      if (raw.schemaVersion === 1 && raw.state?.version === 4) {
        return { ...raw, schemaVersion: 2, retired: true, state: serialize(Journey.resetCampaign(raw.state)) };
      }
      assert(raw.schemaVersion === 2, 'This cloud generation has been retired.');
      return { ...raw, state: serialize(raw.state) };
    }
    async function remoteRead() { assertOnline(); const result = envelope(await transport.read()); assertActive(); return result; }
    function view(record) { return { exists: record.exists, newer: false, state: canonical(record.state), ready, status: lastStatus }; }
    async function replace(expected, state, metadata) {
      let applied = false;
      const result = await localUpdate(current => {
        assertActive();
        if (token({ exists: expected.exists, state: current }) !== token(expected)) return;
        for (const key of Object.keys(current)) delete current[key];
        Object.assign(current, clone(state), { _cloud: clone(metadata) });
        applied = true;
      });
      if (applied) { ready = true; announce(result.state); }
      return applied;
    }
    function restoreChoice(local) {
      const conflict = meta(local.state)?.conflict;
      if (!conflict) return false;
      cancelRetry();
      const states = { local: canonical(local.state) };
      if (conflict.state) states.cloud = clone(conflict.state);
      choice = { localToken: token(local), remoteID: conflict.remoteID, type: conflict.type, states };
      ready = false;
      publish('choice', { choiceType: choice.type, choices: Object.keys(states), states: clone(states) });
      return true;
    }
    async function showChoice(local, remote, type = 'conflict') {
      let applied = false;
      const result = await localUpdate(state => {
        assertActive();
        if (token({ exists: local.exists, state }) !== token(local)) return;
        editableMeta(state).conflict = { type, remoteID: remoteID(remote), state: remote ? clone(remote.state) : null };
        applied = true;
      });
      if (!applied) { resync = true; return; }
      restoreChoice({ exists: true, state: result.state });
    }
    function newID() {
      const crypto = globalThis.crypto;
      if (crypto?.randomUUID) return crypto.randomUUID();
      if (!crypto?.getRandomValues) throw error('cloud/unavailable', 'Secure save identifiers are unavailable.');
      return Array.from(crypto.getRandomValues(new Uint8Array(24)), byte => byte.toString(16).padStart(2, '0')).join('');
    }
    async function acknowledge(pending, remote) {
      assert(remote?.writeId === pending.writeId && fingerprint(remote.state) === fingerprint(pending.state), 'The cloud acknowledgement does not match this save.');
      const result = await localUpdate(state => {
        assertActive();
        const current = meta(state);
        if (current?.pending?.writeId !== pending.writeId) return;
        current.baseWriteId = pending.writeId;
        current.pending = null;
        current.dirty = fingerprint(state) !== fingerprint(pending.state);
        if (!current.dirty) current.uploadRequested = false;
        // Ordinary edits behind this write wait for the next checkpoint. A new
        // bonus/completion/gem checkpoint has already set uploadRequested again.
      });
      ready = !choice;
      announce(result.state);
    }
    async function recordCheckpoint() {
      const marker = checkpointMarker();
      if ((!checkpointRequested && !marker) || choice || checkpointGate?.pending) return;
      checkpointRequested = false;
      await localUpdate(state => {
        assertActive();
        const metadata = editableMeta(state);
        if (metadata.pending ? fingerprint(state) !== fingerprint(metadata.pending.state)
          : metadata.dirty || !metadata.initialized) metadata.uploadRequested = true;
      });
      clearCheckpoint(marker);
    }
    async function runSync() {
      for (let iteration = 0; iteration < 12; iteration++) {
        assertActive();
        await recordCheckpoint();
        const local = await localRead();
        const metadata = meta(local.state);
        if (metadata?.conflict) restoreChoice(local);
        else choice = null;
        ready = !choice;
        const remote = await remoteRead();
        if (token(await localRead()) !== token(local)) continue;
        const base = remoteID(remote);
        if (metadata?.conflict) { await showChoice(local, remote, metadata.conflict.type); return; }
        if (metadata?.pending) {
          const pending = clone(metadata.pending);
          if (base === pending.writeId) { await acknowledge(pending, remote); continue; }
          if (base !== pending.parentWriteId) { await showChoice(local, remote); return; }
          choice = null;
          ready = true;
          publish('syncing');
          assertOnline();
          let committed;
          try { committed = await transport.commit({ schemaVersion: 2, ...pending, createdAt: remote?.createdAt }); }
          catch (failure) {
            // A failed response may follow a committed write. The persisted ID
            // survives reloads and makes that retry an acknowledgement, not credit.
            const observed = await remoteRead();
            if (remoteID(observed) === pending.writeId) { await acknowledge(pending, observed); continue; }
            if (remoteID(observed) !== pending.parentWriteId) { await showChoice(await localRead(), observed); return; }
            throw failure;
          }
          assertActive();
          const confirmed = committed ? envelope(committed) : await remoteRead();
          await acknowledge(pending, confirmed);
          continue;
        }
        if (!metadata?.initialized) {
          if (remote && !sameProgress(local.state, remote.state)) {
            await showChoice(local, remote, 'import'); return;
          }
          // A missing cloud save is initialized from this one local snapshot.
          // Signing in explicitly authorizes this first save. Existing differing
          // snapshots always require a choice, including an empty device save.
          if (!await replace(local, canonical(local.state), journal(base, !remote || remote.retired === true, !remote || remote.retired === true))) continue;
          choice = null;
          continue;
        }
        if (metadata.baseWriteId !== base) {
          if (!remote || !sameProgress(local.state, remote.state)) { await showChoice(local, remote); return; }
          // Equivalent gameplay needs no destructive replacement. Retain local
          // navigation/timestamps while tracking the cloud's current parent ID.
          if (!await replace(local, canonical(local.state), journal(base, false))) continue;
          choice = null;
          publish('synced');
          return;
        }
        if (!metadata.dirty || !wantsUpload(metadata)) {
          if (token(await localRead()) !== token(local)) continue;
          choice = null;
          ready = true;
          publish(metadata.dirty ? 'local' : 'synced');
          return;
        }
        await localUpdate(state => {
          assertActive();
          const current = meta(state);
          if (!current?.initialized || current.pending || !current.dirty || !wantsUpload(current) || current.baseWriteId !== base) return;
          current.pending = { writeId: newID(), parentWriteId: base, state: canonical(state) };
          current.version = 2;
          current.uploadRequested = false;
        });
      }
      resync = true;
    }
    async function snapshot() {
      const record = await localRead();
      const metadata = meta(record.state);
      if (metadata?.conflict) restoreChoice(record);
      else if (choice) {
        // Another tab may have resolved the shared choice. A local read updates
        // this tab's play gate without initiating network traffic for each word.
        choice = null;
        ready = true;
        publish(metadata?.dirty ? 'local' : 'synced');
      }
      return view(record);
    }
    function withSyncLock() {
      if (!locks?.request) return runSync();
      let entered = false;
      return locks.request(`${store.storageKey || 'wordSearch.v5'}:cloud-sync`, () => {
        entered = true;
        return runSync();
      }).catch(failure => {
        if (!entered && failure?.name === 'SecurityError') return runSync();
        throw failure;
      });
    }
    function sync({ checkpoint = false, after } = {}) {
      if (!active) return Promise.reject(error('cloud/stopped', 'This account session has ended.'));
      cancelRetry(false);
      // pagehide cannot wait for a cloud lock or network response. Record a tiny
      // synchronous intent now; the next visit persists it into the local journal.
      if (checkpoint) {
        if (after) {
          const gate = { pending: true, promise: null };
          gate.promise = Promise.resolve(after).catch(() => {}).then(() => { gate.pending = false; });
          checkpointGate = gate;
        }
        retainCheckpoint();
      }
      if (flight) { resync = true; return flight; }
      flight = (async () => {
        let result = null;
        do {
          resync = false;
          retryWanted = false;
          try {
            // The durable intent already exists, but it cannot be consumed
            // until gameplay writes queued before pagehide have committed.
            while (checkpointGate?.pending) await checkpointGate.promise;
            assertActive();
            await withSyncLock();
            cancelRetry();
          }
          catch (failure) {
            if (!active) return null;
            // Connection/profile errors never prevent offline local play. Only
            // an unresolved overwrite choice or unreadable local save blocks it.
            try { await localRead(); ready = !choice; } catch { ready = false; }
            const permanent = permanentFailure(failure);
            if (choice || permanent) cancelRetry();
            else retryWanted = true;
            if (choice) publish('choice', { choiceType: choice.type, choices: Object.keys(choice.states), states: clone(choice.states), error: failure });
            else publish(permanent ? 'error' : 'offline', { error: failure });
          }
          if (!active) return null;
          try { result = await snapshot(); } catch (failure) { cancelRetry(); ready = false; publish('error', { error: failure }); }
        } while (resync && active);
        return result;
      })().finally(() => {
        flight = null;
        if (resync && active) { resync = false; return sync(); }
        scheduleRetry();
      });
      return flight;
    }
    async function start() {
      assertActive();
      ready = false;
      publish('checking');
      try {
        const local = await localRead();
        if (!restoreChoice(local)) { ready = true; publish('checking'); }
      } catch { /* sync publishes the local-storage error consistently. */ }
      return sync();
    }
    function isCheckpoint(before, after) {
      if (before.wallet.gems !== after.wallet.gems) return true;
      if (JSON.stringify(before.progression || baselineProgression(before, Journey)) !==
          JSON.stringify(after.progression || baselineProgression(after, Journey))) return true;
      return Object.entries(after.maps).some(([id, map]) => {
        const previous = before.maps[id];
        return (map.complete && !previous?.complete) || (map.chestOpened && !previous?.chestOpened) ||
          map.bonusWords.some(word => !previous?.bonusWords?.includes(word));
      });
    }
    async function update(change, { checkpoint = false } = {}) {
      assertActive();
      if (!ready || choice) throw error('cloud/choice-required', 'Choose progress before playing.');
      let requestUpload = false;
      const result = await localUpdate(state => {
        assertActive();
        const metadata = editableMeta(state);
        if (metadata.conflict) {
          restoreChoice({ exists: true, state });
          throw error('cloud/choice-required', 'Choose progress before playing.');
        }
        const before = canonical(state);
        const value = change(state);
        if (value && typeof value.then === 'function') throw new TypeError('Save mutations must be synchronous.');
        const after = canonical(state);
        state._cloud = metadata;
        if (JSON.stringify(before) !== JSON.stringify(after)) {
          metadata.dirty = true;
          requestUpload = checkpoint || isCheckpoint(before, after);
          if (requestUpload) metadata.uploadRequested = true;
        }
        return value;
      });
      assertActive();
      announce(result.state);
      if (requestUpload) { publish('syncing'); void sync(); }
      else {
        const metadata = meta(result.state);
        // A pending journal is recovery data, not an active network request.
        // Ordinary play must not replace a failed attempt with a false spinner.
        if (!['offline', 'error'].includes(lastStatus)) {
          publish(metadata?.pending && flight ? 'syncing' : metadata?.dirty ? 'local' : 'synced');
        }
      }
      return { state: canonical(result.state), result: result.result };
    }
    async function resolveChoice(selection) {
      assertActive();
      if (!choice || !Object.hasOwn(choice.states, selection)) throw error('cloud/invalid-choice', 'Choose an available save.');
      cancelRetry();
      if (flight) await flight;
      const selectedChoice = choice;
      if (!selectedChoice) return snapshot();
      try {
        const local = await localRead();
        if (token(local) !== selectedChoice.localToken) return sync();
        let remote, offlineFailure;
        try { remote = await remoteRead(); }
        catch (failure) {
          assertActive();
          offlineFailure = failure;
          remote = selectedChoice.remoteID ? { writeId: selectedChoice.remoteID, state: selectedChoice.states.cloud } : null;
        }
        if (remoteID(remote) !== selectedChoice.remoteID) return sync();
        const state = selection === 'cloud' ? remote.state : selectedChoice.states[selection];
        if (!await replace(local, state, journal(remoteID(remote), selection !== 'cloud' || remote?.retired === true, selection !== 'cloud' || remote?.retired === true))) return sync();
        choice = null;
        checkpointRequested = false;
        clearCheckpoint(checkpointMarker());
        if (offlineFailure) {
          ready = true;
          const permanent = permanentFailure(offlineFailure);
          publish(permanent ? 'error' : 'offline', { error: offlineFailure });
          const result = await snapshot();
          retryWanted = !permanent;
          scheduleRetry();
          return result;
        }
        return sync();
      } catch (failure) {
        if (active) publish('choice', { choiceType: selectedChoice.type, choices: Object.keys(selectedChoice.states),
          states: clone(selectedChoice.states), error: failure });
        throw failure;
      }
    }
    function stop() { if (!active) return; cancelRetry(); publish('stopped'); active = false; ready = false; choice = null; }
    return Object.freeze({ read: snapshot, update, start, resolveChoice, sync, stop,
      checkpoint: () => sync({ checkpoint: true }) });
  }
  return Object.freeze({ create, serialize, hasProgress, progressFingerprint });
});
