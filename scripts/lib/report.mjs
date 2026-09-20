// What a gate says when it has something to say.
//
// Two gates had written this out: the array, the pushing function, and a footer of
// `✗ <gate>: N failure(s)` followed by `  [tag] detail` lines. That shape is not
// decoration — `check-checks.mjs` reads the `[tag]` back out of it to decide whether a
// mutation was caught by the check that claims it, so a gate that spelled the footer
// differently would have its claims silently stop matching. It is one function now, for
// the same reason `region.mjs` is: the copies had already started to differ.
export function reporter(gate) {
  const failures = [];
  return {
    failures,
    fail: (check, detail) => failures.push([check, detail]),
    // Says what went wrong and stops, or returns and lets the run continue. A gate may
    // call it more than once — the lookups check reports as soon as its own fixture has
    // failed, rather than scanning 660 KB to produce findings nobody will read.
    report: (trailer) => {
      if (!failures.length) return;
      console.error(`✗ ${gate}: ${failures.length} failure(s)\n`);
      for (const [check, detail] of failures) console.error(`  [${check}] ${detail}`);
      if (trailer) console.error(`\n${trailer}`);
      process.exit(1);
    },
  };
}
