// The CBA exam blueprint as data. Keep in sync with spec/exam-blueprint.md
// (the CLI `sync` command refreshes both from the official LF page).

export const EXAM = {
  name: 'Certified Backstage Associate (CBA)',
  totalQuestions: 60,
  minutes: 90,
  defaultPassPct: 75, // NOT an official passing score; overridable with --pass.
  blueprintUrl: 'https://training.linuxfoundation.org/certification/certified-backstage-associate-cba/',
};

export const DOMAINS = [
  {
    key: 'development-workflow',
    name: 'Backstage Development Workflow',
    weight: 24,
    prefix: 'dw',
    target: 14,
    competencies: [
      'Build and run Backstage projects locally',
      'Understand local development workflows',
      'Compile a Backstage project with TypeScript',
      'Download and install dependencies for a Backstage project with NPM/Yarn',
      'Use Docker to build a container image of a Backstage project',
    ],
  },
  {
    key: 'infrastructure',
    name: 'Backstage Infrastructure',
    weight: 22,
    prefix: 'infra',
    target: 13,
    competencies: [
      'Understand the Backstage framework',
      'Configure Backstage',
      'Deploy Backstage to production',
      'Understand Backstage client-server architecture',
    ],
  },
  {
    key: 'catalog',
    name: 'Backstage Catalog',
    weight: 22,
    prefix: 'cat',
    target: 13,
    competencies: [
      'Understand how/why to use Backstage Catalog',
      'Populate Backstage Catalog',
      'Using annotations',
      'Working with manually registered entity locations',
      'Troubleshooting entity ingestion',
      'Working with automated ingestion',
    ],
  },
  {
    key: 'customizing',
    name: 'Customizing Backstage',
    weight: 32,
    prefix: 'cust',
    target: 20,
    competencies: [
      'Understand frontend versus backend plugins',
      'Customizing Backstage plugins',
      'Make changes to React code in Backstage App',
      'Using Material UI components',
    ],
  },
];

export const PREFIXES = DOMAINS.map((d) => d.prefix);

export function domainByKey(key) {
  return DOMAINS.find((d) => d.key === key) || null;
}
export function domainByName(name) {
  return DOMAINS.find((d) => d.name === name) || null;
}
export function domainByPrefix(prefix) {
  return DOMAINS.find((d) => d.prefix === prefix) || null;
}

// Resolve a user-supplied domain token (key, prefix, or partial name) to a domain.
export function resolveDomain(token) {
  if (!token) return null;
  const t = String(token).toLowerCase();
  return (
    DOMAINS.find((d) => d.key === t) ||
    DOMAINS.find((d) => d.prefix === t) ||
    DOMAINS.find((d) => d.name.toLowerCase().includes(t)) ||
    null
  );
}

// Split `total` questions across domains proportionally to the 60-question budget,
// using largest-remainder rounding so the parts sum exactly to `total`.
export function allocate(total) {
  const rows = DOMAINS.map((d) => {
    const exact = (d.target * total) / EXAM.totalQuestions;
    return { key: d.key, floor: Math.floor(exact), rem: exact - Math.floor(exact) };
  });
  let left = total - rows.reduce((s, r) => s + r.floor, 0);
  rows.sort((a, b) => b.rem - a.rem);
  for (let i = 0; i < rows.length && left > 0; i++, left--) rows[i].floor++;
  const out = {};
  for (const r of rows) out[r.key] = r.floor;
  return out;
}
