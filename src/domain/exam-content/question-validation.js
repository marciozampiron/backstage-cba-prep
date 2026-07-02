export const DIFFICULTIES = ['easy', 'medium', 'hard'];
export const OPTION_KEYS = ['A', 'B', 'C', 'D'];
export const QUESTION_KEYS = [
  'id',
  'domain',
  'competency',
  'difficulty',
  'question',
  'options',
  'answer',
  'explanation',
  'source',
  'tags',
];

export function validateQuestion(q, domain, seen, { domainKey = domain?.key } = {}) {
  const errs = [];
  const id = q && q.id;
  const label = typeof id === 'string' ? id : JSON.stringify(id);

  if (!q || typeof q !== 'object' || Array.isArray(q)) {
    return [label + ': question must be an object'];
  }

  const extraQuestionKeys = Object.keys(q).filter((k) => !QUESTION_KEYS.includes(k) && !k.startsWith('_'));
  if (extraQuestionKeys.length) errs.push(label + ': unexpected question keys: ' + extraQuestionKeys.join(', '));

  if (typeof id !== 'string' || !/^[a-z]+-\d{3}$/.test(id)) {
    errs.push(label + ': id must match <prefix>-NNN (e.g. ' + (domain?.prefix || 'dw') + '-001)');
  } else {
    if (domain && !id.startsWith(domain.prefix + '-')) errs.push(id + ': id prefix should be "' + domain.prefix + '" in ' + domainKey + '.json');
    if (seen) {
      if (seen.has(id)) errs.push(id + ': duplicate id');
      seen.add(id);
    }
  }
  if (domain && q.domain !== domain.name) errs.push(label + ': domain should be "' + domain.name + '", got ' + JSON.stringify(q.domain));
  if (!q.competency) errs.push(label + ': missing competency');
  else if (domain && !domain.competencies.includes(q.competency)) errs.push(label + ': competency not in blueprint: ' + JSON.stringify(q.competency));
  if (!DIFFICULTIES.includes(q.difficulty)) errs.push(label + ': difficulty must be easy|medium|hard');
  if (typeof q.question !== 'string' || q.question.trim().length < 10) errs.push(label + ': question missing or too short');

  const opts = q.options || {};
  if (!opts || typeof opts !== 'object' || Array.isArray(opts)) {
    errs.push(label + ': options must be an object with A/B/C/D keys');
  } else {
    for (const k of OPTION_KEYS) if (typeof opts[k] !== 'string' || !opts[k].trim()) errs.push(label + ': missing/empty option ' + k);
    const extra = Object.keys(opts).filter((k) => !OPTION_KEYS.includes(k));
    if (extra.length) errs.push(label + ': unexpected option keys: ' + extra.join(', '));

    const normalizedOptions = OPTION_KEYS
      .map((k) => (typeof opts[k] === 'string' ? opts[k].trim().replace(/\s+/g, ' ') : null))
      .filter(Boolean);
    const duplicates = normalizedOptions.filter((option, i) => normalizedOptions.indexOf(option) !== i);
    if (duplicates.length) errs.push(label + ': duplicate option text: ' + [...new Set(duplicates)].join('; '));
  }

  if (!OPTION_KEYS.includes(q.answer)) errs.push(label + ': answer must be one of A|B|C|D');
  if (typeof q.explanation !== 'string' || q.explanation.trim().length < 10) errs.push(label + ': explanation missing or too short');
  if (typeof q.source !== 'string' || !/^https?:\/\//.test(q.source)) {
    errs.push(label + ': source must be an http(s) URL');
  } else {
    try {
      const url = new URL(q.source);
      const officialBackstageDoc = url.origin === 'https://backstage.io' && url.pathname.startsWith('/docs/');
      const officialBlueprint =
        url.origin === 'https://training.linuxfoundation.org' &&
        url.pathname.startsWith('/certification/certified-backstage-associate-cba');
      if (!officialBackstageDoc && !officialBlueprint) {
        errs.push(label + ': source must be an official Backstage docs or LF CBA blueprint URL');
      }
    } catch {
      errs.push(label + ': source must be a valid URL');
    }
  }
  if (q.tags !== undefined) {
    if (!Array.isArray(q.tags)) errs.push(label + ': tags must be an array of strings');
    else {
      for (const [i, tag] of q.tags.entries()) {
        if (typeof tag !== 'string') errs.push(label + ': tags[' + i + '] must be a string');
      }
    }
  }
  return errs;
}
