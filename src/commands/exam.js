import { EXAM, DOMAINS, domainByKey } from '../lib/blueprint.js';
import { sample, shuffle } from '../lib/bank.js';
import { summarize } from '../lib/score.js';
import { c, hr, bar, ask, closeInput } from '../lib/ui.js';
import { record } from '../lib/history.js';

function fmtTime(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

// Randomize option order so position gives nothing away; remap the correct letter.
function shuffleOptions(q) {
  const entries = shuffle(Object.entries(q.options));
  const options = {};
  let answer = null;
  entries.forEach(([orig, text], i) => {
    const letter = ['A', 'B', 'C', 'D'][i];
    options[letter] = text;
    if (orig === q.answer) answer = letter;
  });
  return { options, answer };
}

export async function runExam(opts) {
  const count = opts.count ?? EXAM.totalQuestions;
  const minutes = opts.minutes ?? EXAM.minutes;
  const passPct = opts.pass ?? EXAM.defaultPassPct;
  const timed = opts.timer !== false;
  const shuffleOpts = opts.shuffleOptions !== false;

  const questions = sample(count, opts.domain ? { domainKey: opts.domain } : {});
  if (questions.length === 0) {
    console.log(c.red('\n  No questions available. Run `node bin/cli.js validate` to check the bank.\n'));
    return;
  }
  const short = questions.length < count;

  console.log(`\n  ${c.bold(c.cyan(`${EXAM.name} — Mock Exam`))}`);
  console.log(hr());
  console.log(
    `  Questions: ${c.bold(questions.length)}${short ? c.yellow(` (bank has fewer than ${count})`) : ''}` +
      `   Time: ${timed ? c.bold(`${minutes} min`) : 'untimed'}   Target: ${passPct}%`
  );
  console.log(c.gray('  Answer A/B/C/D · S to skip · Q to quit and score'));
  console.log(hr());
  await ask(c.dim('  Press Enter to start... '));

  const start = Date.now();
  const limitMs = minutes * 60 * 1000;
  const results = [];

  for (let i = 0; i < questions.length; i++) {
    if (timed && limitMs - (Date.now() - start) <= 0) {
      console.log(c.yellow('\n  ⏰ Time is up — scoring what you answered.'));
      break;
    }
    const q = questions[i];
    const view = shuffleOpts ? shuffleOptions(q) : { options: q.options, answer: q.answer };
    const dObj = domainByKey(q._domainKey);
    const time = timed ? `   ${c.gray(`⏱ ${fmtTime(limitMs - (Date.now() - start))}`)}` : '';

    console.log(`\n  ${c.bold(`Q${i + 1}/${questions.length}`)}  ${c.blue(dObj ? dObj.name : q.domain)} ${c.gray(`· ${q.difficulty}`)}${time}`);
    console.log(`  ${q.question}`);
    for (const L of ['A', 'B', 'C', 'D']) console.log(`     ${c.bold(L)}. ${view.options[L]}`);

    let answer = null;
    let quit = false;
    while (answer === null) {
      const raw = (await ask('  > ')).trim().toUpperCase();
      if (raw === 'Q') { quit = true; break; }
      if (raw === 'S' || raw === '') { answer = 'SKIP'; break; }
      if (['A', 'B', 'C', 'D'].includes(raw)) { answer = raw; break; }
      console.log(c.gray('     (enter A, B, C, D, S=skip, Q=quit)'));
    }
    if (quit) break;

    const skipped = answer === 'SKIP';
    results.push({
      domainKey: q._domainKey,
      correct: !skipped && answer === view.answer,
      skipped,
      chosen: skipped ? null : answer,
      correctLetter: view.answer,
      view,
      q,
    });
  }

  closeInput();
  const summary = report(results, passPct);
  if (opts.save !== false && results.length) {
    const perDomain = {};
    for (const d of DOMAINS) {
      const p = summary.per[d.key];
      if (p.total) perDomain[d.key] = { correct: p.correct, total: p.total };
    }
    const saved = record({
      date: new Date().toISOString(),
      domain: opts.domain || 'all',
      count: summary.total,
      correct: summary.correct,
      pct: summary.pct,
      perDomain,
    });
    if (saved) console.log(c.gray('  Saved to history — see: node bin/cli.js history\n'));
  }
}

function report(results, passPct) {
  const s = summarize(results);
  console.log(`\n${hr('═')}`);
  console.log(`  ${c.bold('RESULTS')}`);
  console.log(hr('═'));
  const pass = s.pct >= passPct;
  console.log(
    `  Score: ${c.bold(`${s.correct}/${s.total}`)} (${s.pct}%)   ` +
      `${pass ? c.green('ON TRACK') : c.red('BELOW TARGET')} ${c.gray(`· target ${passPct}%`)}`
  );
  console.log(c.gray(`  Answered ${s.answered}, skipped ${s.total - s.answered}. Target is a study goal, not an official passing score.`));

  console.log(`\n  ${c.bold('By domain')} ${c.gray('(vs. exam weight)')}:`);
  for (const d of DOMAINS) {
    const p = s.per[d.key];
    if (!p.total) continue;
    const pct = Math.round((p.correct / p.total) * 100);
    console.log(`    ${d.name.padEnd(32)} ${String(p.correct).padStart(2)}/${String(p.total).padStart(2)}  ${bar(pct)} ${String(pct).padStart(3)}%  ${c.gray(`w:${d.weight}%`)}`);
  }

  const missed = results.filter((r) => !r.correct);
  if (missed.length) {
    console.log(`\n  ${c.bold('Review')} ${c.gray(`(${missed.length} to revisit)`)}:`);
    for (const r of missed) {
      console.log(`\n    ${c.red('✗')} ${c.bold(r.q.question)}`);
      console.log(`      ${c.green(`✓ ${r.correctLetter}. ${r.view.options[r.correctLetter]}`)}`);
      if (!r.skipped) console.log(`      ${c.red(`your answer: ${r.chosen}. ${r.view.options[r.chosen]}`)}`);
      else console.log(`      ${c.yellow('skipped')}`);
      console.log(`      ${c.gray(r.q.explanation)}`);
      console.log(`      ${c.cyan(r.q.source)}`);
    }
  }
  // Study plan: weakest competencies first, each with a doc link to study next.
  const comp = {};
  for (const r of results) {
    const name = r.q.competency;
    if (!comp[name]) comp[name] = { correct: 0, total: 0, source: r.q.source, gapSource: null };
    comp[name].total += 1;
    if (r.correct) comp[name].correct += 1;
    else if (!comp[name].gapSource) comp[name].gapSource = r.q.source;
  }
  const weakComps = Object.entries(comp)
    .map(([name, v]) => ({ name, ...v, pct: v.total ? v.correct / v.total : 0 }))
    .filter((v) => v.correct < v.total)
    .sort((a, b) => a.pct - b.pct || b.total - a.total)
    .slice(0, 6);
  if (weakComps.length) {
    console.log(`\n  ${c.bold('Study plan')} ${c.gray('(weakest competencies first)')}:`);
    for (const w of weakComps) {
      console.log(`    ${c.red(`${w.correct}/${w.total}`)}  ${w.name}`);
      console.log(`      ${c.cyan(w.gapSource || w.source)}`);
    }
  }

  const weakest = DOMAINS
    .map((d) => ({ d, p: s.per[d.key] }))
    .filter((x) => x.p.total)
    .sort((a, b) => a.p.correct / a.p.total - b.p.correct / b.p.total)[0];
  console.log(`\n${hr()}`);
  if (weakest && weakest.p.correct < weakest.p.total) {
    console.log(c.gray(`  Next: drill your weakest domain → node bin/cli.js exam --domain ${weakest.d.key}`));
  }
  console.log('');
  return s;
}
