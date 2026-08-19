const DEFAULTS = {
  studentGraduationRate: 0.10,
  retirementRate: 0.04,
  matriculationRate: 0.006
};

function runLifecycleTransitions(worldState) {
  const s = { ...DEFAULTS, ...(worldState.settings?.households || {}) };
  const households = worldState.households;
  if (!Array.isArray(households) || !households.length) return;

  const byProvince = new Map();
  for (const hh of households) {
    if (!byProvince.has(hh.provinceId)) byProvince.set(hh.provinceId, []);
    byProvince.get(hh.provinceId).push(hh);
  }

  for (const hhs of byProvince.values()) {
    const find = (lifecycle, axes) => hhs.find(h =>
      h.axes?.lifecycle === lifecycle &&
      h.axes.class === axes.class &&
      h.axes.location === axes.location &&
      h.axes.quintile === axes.quintile
    );

    // FIX: graduates used to land in working_class regardless of origin
    // class. Class is now preserved.
    for (const hh of hhs) {
      if (hh.axes?.lifecycle !== 'student') continue;
      const movers = Math.floor((hh.population || 0) * s.studentGraduationRate);
      if (movers <= 0) continue;
      const target = find('working_age', hh.axes);
      if (!target) continue;
      hh.population -= movers;
      target.population += movers;
    }

    for (const hh of hhs) {
      if (hh.axes?.lifecycle !== 'working_age') continue;
      const retirees = Math.floor((hh.population || 0) * s.retirementRate);
      if (retirees > 0) {
        const target = find('retired', hh.axes);
        if (target) { hh.population -= retirees; target.population += retirees; }
      }
      // FIX: students had zero inflow and drained to extinction in ~40
      // turns. Model children reaching school age.
      const entrants = Math.floor((hh.population || 0) * s.matriculationRate);
      if (entrants > 0) {
        const target = find('student', hh.axes);
        if (target) { hh.population -= entrants; target.population += entrants; }
      }
    }
  }
}

module.exports = { runLifecycleTransitions };

