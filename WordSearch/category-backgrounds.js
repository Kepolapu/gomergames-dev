(function (root, factory) {
  'use strict';
  const backgrounds = factory();
  if (typeof module === 'object' && module.exports) module.exports = backgrounds;
  else root.WordSearchCategoryBackgrounds = backgrounds;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // Shared by gameplay and the offline cache; artwork is independent of seed data.
  return Object.freeze({
    'Farm Animals': 'backgrounds/farm-scenery-portrait-v1.webp',
    Birds: 'backgrounds/birds-scenery-portrait-v1.webp',
    Fish: 'backgrounds/fish-scenery-portrait-v1.webp',
    'Ocean Animals': 'backgrounds/ocean-animals-scenery-portrait-v1.webp',
    Space: 'backgrounds/space-scenery-portrait-v1.webp',
    'Wild Animals': 'backgrounds/wild-animals-scenery-portrait-v1.webp'
  });
});
