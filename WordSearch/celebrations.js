/* Lightweight visual feedback. Progress and scoring belong to the game. */
(function () {
  'use strict';

  const colors = ['#e6b74e', '#edcf73', '#80a768', '#bbd49c', '#ed826f', '#f7f0d6'];
  const animationTimers = new WeakMap();
  const between = (min, max) => min + Math.random() * (max - min);

  function animateAnchor(anchor, className) {
    if (!anchor) return;
    clearTimeout(animationTimers.get(anchor));
    anchor.classList.remove('is-opening', 'is-celebrating');
    // Start each new discovery's pulse even when discoveries are close together.
    void anchor.offsetWidth;
    anchor.classList.add(className);
    animationTimers.set(anchor, setTimeout(() => {
      anchor.classList.remove(className);
      animationTimers.delete(anchor);
    }, 950));
  }

  function celebrate(kind, anchor) {
    document.body.dataset.lastCelebration = kind;
    document.body.dataset.celebrationCount = String((Number(document.body.dataset.celebrationCount) || 0) + 1);
    animateAnchor(anchor, kind === 'chest' ? 'is-opening' : 'is-celebrating');
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    const layer = document.createElement('div');
    layer.className = 'celebration-layer';
    layer.dataset.celebration = kind;
    layer.setAttribute('aria-hidden', 'true');
    // A modal is in the browser's top layer. Host its confetti there too.
    const dialogs = Array.from(document.querySelectorAll('dialog[open]'));
    (dialogs[dialogs.length - 1] || document.body).append(layer);
    const width = window.innerWidth;
    const height = window.innerHeight;
    const rect = anchor?.getBoundingClientRect();
    const origin = rect ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
      : { x: width / 2, y: height / 3 };
    const big = kind === 'chest';
    const fullCount = big ? 140 : 70;
    const localCount = big ? 44 : 24;
    const animations = [];

    function particle(local, index) {
      const piece = document.createElement('i');
      piece.className = 'confetti-particle';
      piece.style.background = colors[index % colors.length];
      const size = between(5, big ? 11 : 9);
      piece.style.width = `${size}px`;
      piece.style.height = `${size * between(.6, 1.6)}px`;
      if (index % 4 === 0) piece.style.borderRadius = '50%';
      const x = local ? origin.x : between(0, width);
      const y = local ? origin.y : between(-50, -15);
      piece.style.left = `${x}px`;
      piece.style.top = `${y}px`;
      layer.append(piece);
      const dx = local ? between(-1, 1) * (big ? 220 : 120) : between(-80, 80);
      const dy = local ? between(70, big ? 230 : 160) : height + 80;
      const rise = local ? between(35, big ? 160 : 90) : -dy * .3;
      const spin = between(-460, 460);
      const animation = piece.animate([
        { transform: 'translate(-50%, -50%) rotate(0deg)', opacity: 0, offset: 0 },
        { transform: `translate(calc(-50% + ${dx * .4}px), calc(-50% - ${rise}px)) rotate(${spin * .3}deg)`, opacity: 1, offset: .25 },
        { opacity: 1, offset: .65 },
        { transform: `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px)) rotate(${spin}deg)`, opacity: 0, offset: 1 }
      ], {
        duration: local ? between(800, 1300) : between(1400, big ? 2500 : 2100),
        delay: local ? 0 : between(0, big ? 250 : 120),
        easing: local ? 'cubic-bezier(.16,.55,.55,1)' : 'linear',
        fill: 'both'
      });
      animations.push(animation.finished.catch(() => {}));
    }

    for (let index = 0; index < fullCount; index++) particle(false, index);
    for (let index = 0; index < localCount; index++) particle(true, index);
    Promise.all(animations).then(() => layer.remove());
  }

  function celebrateWord(anchors, color) {
    const noop = () => {};
    const origins = (anchors || []).filter(anchor => anchor?.isConnected).map(anchor => {
      const rect = anchor.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2,
        size: Math.min(rect.width, rect.height) };
    }).filter(origin => origin.size > 0);
    if (!origins.length) return noop;
    document.body.dataset.lastCelebration = 'word';
    document.body.dataset.celebrationCount = String((Number(document.body.dataset.celebrationCount) || 0) + 1);
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return noop;

    const layer = document.createElement('div');
    layer.className = 'celebration-layer';
    layer.dataset.celebration = 'word';
    layer.setAttribute('aria-hidden', 'true');
    // The fixed body layer shares the cells' viewport coordinates, even when
    // the game itself has been scaled to fit a small screen.
    document.body.append(layer);
    const animations = [];
    const palette = [color || '#cdddba', '#eeca7e', '#fff2c5'];
    const count = 24;
    for (let index = 0; index < count; index++) {
      const origin = origins[Math.floor(index * origins.length / count)];
      const piece = document.createElement('i');
      piece.className = 'confetti-particle';
      const size = between(4, 6);
      piece.style.width = `${size}px`;
      piece.style.height = `${size * between(.7, 1.5)}px`;
      piece.style.background = '#eeca7e';
      piece.style.left = `${origin.x + between(-.15, .15) * origin.size}px`;
      piece.style.top = `${origin.y + between(-.15, .15) * origin.size}px`;
      if (index % 3 === 0) piece.style.borderRadius = '50%';
      layer.append(piece);
      const dx = between(-45, 45), rise = between(22, 52), fall = between(12, 38);
      const spin = between(-180, 180);
      const animation = piece.animate([
        { transform: 'translate(-50%, -50%) scale(.65) rotate(0deg)', opacity: 0,
          backgroundColor: '#eeca7e', offset: 0 },
        { transform: `translate(calc(-50% + ${dx * .45}px), calc(-50% - ${rise}px)) scale(1) rotate(${spin * .45}deg)`,
          opacity: .95, backgroundColor: '#eeca7e', offset: .28 },
        { opacity: .85, backgroundColor: palette[index % palette.length], offset: .65 },
        { transform: `translate(calc(-50% + ${dx}px), calc(-50% + ${fall}px)) scale(.7) rotate(${spin}deg)`,
          opacity: 0, backgroundColor: palette[index % palette.length], offset: 1 }
      ], { duration: between(660, 820), delay: between(0, 20), easing: 'cubic-bezier(.16,.55,.55,1)', fill: 'both' });
      animations.push(animation);
    }
    let removed = false;
    const cleanup = () => {
      if (removed) return;
      removed = true;
      animations.forEach(animation => animation.cancel());
      layer.remove();
    };
    Promise.all(animations.map(animation => animation.finished.catch(() => {}))).then(cleanup);
    return cleanup;
  }

  window.WordSearchCelebration = Object.freeze({
    word: celebrateWord,
    bonus(anchor) { celebrate('bonus', anchor); },
    chest(anchor) { celebrate('chest', anchor); }
  });
})();
