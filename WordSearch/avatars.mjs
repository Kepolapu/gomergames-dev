// Avatar IDs are account data; their artwork is trusted, local markup only.
const PRESETS = Object.freeze({
  default: Object.freeze({ label: 'Default avatar', markup: `
    <circle cx="16" cy="10" r="5" fill="#4b7051"/>
    <path d="M6 27v-2a10 10 0 0 1 20 0v2Z" fill="#4b7051"/>` }),
  fox: Object.freeze({ label: 'Fox', markup: `
    <path d="M5 14 4 3l10 7m13 4 1-11-10 7" fill="#e88737" stroke="#87502d" stroke-width="1.2" stroke-linejoin="round"/>
    <path d="m7 6 1 7 5-3m12-4-1 7-5-3" fill="#f5c2a0"/>
    <path d="M4 15c0-7 24-7 24 0 0 8-7 14-12 14S4 23 4 15Z" fill="#e88737"/>
    <path d="M5 17c4-3 8 0 11 7 3-7 7-10 11-7-2 7-7 12-11 12S7 24 5 17Z" fill="#fff4db"/>
    <path d="m13 23 3-2 3 2-3 3Z" fill="#33453e"/>
    <circle cx="10.5" cy="16" r="1.5" fill="#33453e"/><circle cx="21.5" cy="16" r="1.5" fill="#33453e"/>` }),
  owl: Object.freeze({ label: 'Owl', markup: `
    <path d="M5 4 12 8h8l7-4v15c0 7-5 11-11 11S5 26 5 19Z" fill="#917050"/>
    <path d="M8 21c0 5 4 8 8 8s8-3 8-8" fill="#cfb98d"/>
    <circle cx="10.5" cy="15" r="6" fill="#fff2ce"/><circle cx="21.5" cy="15" r="6" fill="#fff2ce"/>
    <circle cx="11" cy="15" r="2.1" fill="#33453e"/><circle cx="21" cy="15" r="2.1" fill="#33453e"/>
    <circle cx="11.6" cy="14.3" r=".65" fill="#fff"/><circle cx="21.6" cy="14.3" r=".65" fill="#fff"/>
    <path d="m13.3 20 2.7-3 2.7 3-2.7 3.5Z" fill="#e5a23b"/>
    <path d="m12 25 1 1m5-1 1 1" stroke="#917050" stroke-width="1.5" stroke-linecap="round"/>` }),
  cat: Object.freeze({ label: 'Cat', markup: `
    <path d="M5 15 4 4l9 5h6l9-5-1 11v5c0 6-5 9-11 9S5 26 5 20Z" fill="#cf9562"/>
    <path d="m7 7 1 7 4-4m13-3-1 7-4-4" fill="#edc0ad"/>
    <path d="M13 9v4m6-4v4" stroke="#9c6347" stroke-width="2" stroke-linecap="round"/>
    <ellipse cx="16" cy="23" rx="6" ry="4" fill="#fff0d4"/>
    <circle cx="10.5" cy="18" r="1.5" fill="#33453e"/><circle cx="21.5" cy="18" r="1.5" fill="#33453e"/>
    <path d="m13.5 21 2.5-1 2.5 1-2.5 2.5Z" fill="#a76d68"/>
    <path d="M16 23v1.5m-9-3-4-1m4 4-4 1m22-4 4-1m-4 4 4 1" stroke="#785643" stroke-width="1.1" stroke-linecap="round"/>` }),
  dog: Object.freeze({ label: 'Dog', markup: `
    <path d="M10 7C3 4 1 14 3 21c1 3 5 2 7-1m12-13c7-3 9 7 7 14-1 3-5 2-7-1" fill="#986547"/>
    <path d="M6 15c0-7 4-10 10-10s10 3 10 10v6c0 6-4 9-10 9S6 27 6 21Z" fill="#e1b97e"/>
    <path d="M15 6c-6-1-9 4-9 10 0 5 8 5 9 0Z" fill="#b17b52"/>
    <ellipse cx="16" cy="23" rx="7" ry="5" fill="#fff1d5"/>
    <circle cx="11" cy="16" r="1.5" fill="#33453e"/><circle cx="21" cy="16" r="1.5" fill="#33453e"/>
    <path d="M12.5 21c0-2 7-2 7 0 0 2-2 3-3.5 3s-3.5-1-3.5-3Z" fill="#33453e"/>
    <path d="M14 25h4v2a2 2 0 0 1-4 0Z" fill="#d88883"/>` }),
  panda: Object.freeze({ label: 'Panda', markup: `
    <circle cx="7" cy="7" r="5" fill="#3c4b47"/><circle cx="25" cy="7" r="5" fill="#3c4b47"/>
    <path d="M3 18C3 9 8 5 16 5s13 4 13 13c0 8-6 12-13 12S3 26 3 18Z" fill="#fff9e9" stroke="#d4d9c9" stroke-width="1"/>
    <ellipse cx="10" cy="16" rx="4" ry="5" transform="rotate(25 10 16)" fill="#3c4b47"/>
    <ellipse cx="22" cy="16" rx="4" ry="5" transform="rotate(-25 22 16)" fill="#3c4b47"/>
    <circle cx="10.8" cy="15.5" r="1.15" fill="#fff9e9"/><circle cx="21.2" cy="15.5" r="1.15" fill="#fff9e9"/>
    <path d="M13 22c0-2 6-2 6 0 0 1-2 3-3 3s-3-2-3-3Z" fill="#3c4b47"/>
    <path d="M13 26q3 2 6 0" fill="none" stroke="#3c4b47" stroke-width="1.2" stroke-linecap="round"/>` }),
  bear: Object.freeze({ label: 'Bear', markup: `
    <circle cx="7" cy="7" r="5" fill="#ab754d"/><circle cx="25" cy="7" r="5" fill="#ab754d"/>
    <circle cx="7" cy="7" r="2.6" fill="#e2b58b"/><circle cx="25" cy="7" r="2.6" fill="#e2b58b"/>
    <path d="M3 18C3 9 8 5 16 5s13 4 13 13c0 8-6 12-13 12S3 26 3 18Z" fill="#ab754d"/>
    <ellipse cx="16" cy="23" rx="7" ry="5" fill="#e9c497"/>
    <circle cx="10" cy="16" r="1.5" fill="#33453e"/><circle cx="22" cy="16" r="1.5" fill="#33453e"/>
    <path d="M12.5 21c0-2 7-2 7 0 0 2-2 3-3.5 3s-3.5-1-3.5-3Z" fill="#33453e"/>
    <path d="M13 26q3 2 6 0" fill="none" stroke="#75513e" stroke-width="1.2" stroke-linecap="round"/>` }),
  frog: Object.freeze({ label: 'Frog', markup: `
    <circle cx="8" cy="10" r="6" fill="#7eac63"/><circle cx="24" cy="10" r="6" fill="#7eac63"/>
    <ellipse cx="16" cy="20" rx="14" ry="10" fill="#7eac63"/>
    <ellipse cx="16" cy="24" rx="9" ry="5" fill="#c9dca3"/>
    <circle cx="8" cy="10" r="3.8" fill="#fff7df"/><circle cx="24" cy="10" r="3.8" fill="#fff7df"/>
    <circle cx="8.5" cy="10.5" r="1.8" fill="#33453e"/><circle cx="23.5" cy="10.5" r="1.8" fill="#33453e"/>
    <ellipse cx="6" cy="20" rx="2.5" ry="1.5" fill="#d9a798"/><ellipse cx="26" cy="20" rx="2.5" ry="1.5" fill="#d9a798"/>
    <path d="M9 21q7 7 14 0" fill="none" stroke="#3f6850" stroke-width="1.5" stroke-linecap="round"/>` }),
  bee: Object.freeze({ label: 'Bee', markup: `
    <path d="M13 11C5 1 0 10 5 15l7 3m7-7c8-10 13-1 8 4l-7 3" fill="#d6eced" stroke="#a0c7cb" stroke-width="1"/>
    <path d="m12 7-2-4m10 4 2-4" stroke="#665744" stroke-width="1.5" stroke-linecap="round"/>
    <ellipse cx="16" cy="18" rx="9" ry="12" fill="#f3c75d"/>
    <path d="M7.3 20h17.4l-.7 4H8Zm3 7h11.4a8 8 0 0 1-11.4 0Z" fill="#665744"/>
    <circle cx="12" cy="13" r="1.3" fill="#33453e"/><circle cx="20" cy="13" r="1.3" fill="#33453e"/>
    <path d="M13 16q3 2 6 0" fill="none" stroke="#665744" stroke-width="1.2" stroke-linecap="round"/>` }),
  butterfly: Object.freeze({ label: 'Butterfly', markup: `
    <path d="M15 15C6 0 1 3 2 12c0 6 5 8 11 7-9 0-10 9-4 11 4 1 6-5 7-9m1-6C26 0 31 3 30 12c0 6-5 8-11 7 9 0 10 9 4 11-4 1-6-5-7-9" fill="#9c85bb"/>
    <path d="M11 13C5 5 4 8 6 12c1 2 3 3 5 3m10-2c6-8 7-5 5-1-1 2-3 3-5 3" fill="#d6c4e9"/>
    <path d="M12 22c-5 0-6 4-3 5 2 0 3-2 3-5m8 0c5 0 6 4 3 5-2 0-3-2-3-5" fill="#eac69f"/>
    <path d="m14 9-3-5m7 5 3-5" stroke="#586455" stroke-width="1.3" stroke-linecap="round"/>
    <path d="M16 12v13" stroke="#586455" stroke-width="3.5" stroke-linecap="round"/>
    <circle cx="16" cy="11" r="3.5" fill="#78856c"/>
    <circle cx="14.7" cy="10.5" r=".6" fill="#fff6df"/><circle cx="17.3" cy="10.5" r=".6" fill="#fff6df"/>` }),
  turtle: Object.freeze({ label: 'Turtle', markup: `
    <path d="m9 17-5-1-2 3 6 3m15-5 5-1 2 3-6 3M10 26l-3 4h5l2-4m8 0 3 4h-5l-2-4" fill="#89ad76"/>
    <ellipse cx="16" cy="9" rx="6" ry="7" fill="#a3c184"/>
    <circle cx="13.5" cy="7.5" r="1.1" fill="#33453e"/><circle cx="18.5" cy="7.5" r="1.1" fill="#33453e"/>
    <path d="M14 11q2 1.5 4 0" fill="none" stroke="#587251" stroke-width="1" stroke-linecap="round"/>
    <ellipse cx="16" cy="21" rx="10" ry="9" fill="#547b5a"/>
    <path d="m12 17 8 0 3 5-4 5h-6l-4-5Z" fill="#87a969" stroke="#365b49" stroke-width="1.1"/>
    <path d="m12 17-3-2m11 2 3-2M9 22H6m17 0h3m-13 5-1 2m7-2 1 2" stroke="#365b49" stroke-width="1.1"/>` }),
  rabbit: Object.freeze({ label: 'Rabbit', markup: `
    <ellipse cx="10" cy="9" rx="4" ry="8" transform="rotate(-12 10 9)" fill="#e7dfcd" stroke="#c8c3b5" stroke-width=".8"/>
    <ellipse cx="22" cy="9" rx="4" ry="8" transform="rotate(12 22 9)" fill="#e7dfcd" stroke="#c8c3b5" stroke-width=".8"/>
    <ellipse cx="10" cy="8" rx="1.8" ry="5" transform="rotate(-12 10 8)" fill="#dcaaa9"/>
    <ellipse cx="22" cy="8" rx="1.8" ry="5" transform="rotate(12 22 8)" fill="#dcaaa9"/>
    <path d="M4 22c0-7 5-11 12-11s12 4 12 11c0 6-5 9-12 9S4 28 4 22Z" fill="#f7efdf" stroke="#c8c3b5" stroke-width=".8"/>
    <circle cx="10.5" cy="20" r="1.4" fill="#33453e"/><circle cx="21.5" cy="20" r="1.4" fill="#33453e"/>
    <path d="m13.5 24 2.5-1 2.5 1-2.5 2Z" fill="#c98d94"/>
    <path d="M16 26v2m-6-3-4-1m16 1 4-1" stroke="#b5a994" stroke-width="1" stroke-linecap="round"/>` }),
});

export const AVATARS = Object.freeze(Object.entries(PRESETS).map(([id, preset]) =>
  Object.freeze({ id, label: preset.label })));

export function normalizeAvatarId(value) {
  return typeof value === 'string' && Object.hasOwn(PRESETS, value) ? value : 'default';
}

export function renderAvatar(host, id) {
  const avatarId = normalizeAvatarId(id);
  if (host.dataset.avatarId === avatarId && host.firstElementChild?.localName === 'svg') return;
  const svg = host.ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 32 32');
  svg.setAttribute('width', '32');
  svg.setAttribute('height', '32');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  // The ID is allowlisted above; user values are never interpolated into markup.
  svg.innerHTML = PRESETS[avatarId].markup;
  host.replaceChildren(svg);
  host.dataset.avatarId = avatarId;
}

if (typeof window !== 'undefined') {
  window.GomerAvatars = Object.freeze({ renderAvatar, normalizeAvatarId });
}
