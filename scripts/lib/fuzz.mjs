// A deterministic pseudo-random generator, shared.
//
// Seeded, so a CI failure is reproducible from the seed alone rather than being a story
// about a run nobody can repeat. Here rather than in each check because the second copy
// was already wrong: written with the textbook constants, `x * 1103515245` leaves the
// range JavaScript numbers hold exactly, the low bits come back as noise, and the
// dependency fuzz produced a loop in 8 of 1000 graphs where it should have been most of
// them. `Math.imul` keeps the multiplication in 32 bits, which is what the constants
// assume.
//
// Node builtins only — in fact none.

/** @param {number} seed @returns {() => number} the next value in [0, 1) */
export function lcg(seed) {
  let x = seed >>> 0;
  return () => ((x = (Math.imul(x, 1664525) + 1013904223) >>> 0) / 4294967296);
}
