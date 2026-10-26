import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const base = path.dirname(fileURLToPath(import.meta.url));
const json = value => `${JSON.stringify(value, null, 2)}\n`;
const hash = value => createHash('sha256').update(value).digest('hex');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const key = value => String(value).normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/ё/gu, 'е').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const competitions = new Set(['ucl', 'la_liga', 'premier_league', 'serie_a', 'bundesliga', 'ligue_1']);

function selectQuestions(pack, count, seed) {
  // Stable permutation and round-robin question types. No questions or facts are invented.
  const items = [...pack.items].sort((a, b) => hash(`${seed}:${a.id}`).localeCompare(hash(`${seed}:${b.id}`)));
  const buckets = new Map();
  for (const question of items) {
    const group = question.kind === 'season_table' ? 'season' : /Кто этот|Как зовут главного тренера/u.test(question.questionText) ? 'portrait' : question.kind;
    if (!buckets.has(group)) buckets.set(group, []);
    buckets.get(group).push(question);
  }
  const result = [];
  while (result.length < count && [...buckets.values()].some(bucket => bucket.length)) {
    for (const [group, bucket] of buckets) {
      if (!bucket.length || result.length >= count) continue;
      if (group === 'season' && result.filter(q => q.kind === 'season_table').length >= 2) { bucket.length = 0; continue; }
      result.push(bucket.shift());
    }
  }
  assert.equal(result.length, count, `Not enough diverse authored questions: ${pack.id}`);
  return result;
}

export function validateWorldContent(directory) {
  const data = path.join(directory, 'content/src-assets/data');
  const pointer = read(path.join(data, 'current-matchday.json'));
  assert.match(pointer.file, /^mt_[a-z0-9_]+\.json$/u);
  assert.match(pointer.sha256, /^[a-f0-9]{64}$/u);
  const bytes = fs.readFileSync(path.join(data, pointer.file));
  assert.equal(hash(bytes), pointer.sha256, 'Payload checksum mismatch');
  assert.equal(bytes.length, pointer.bytes, 'Payload byte size mismatch');
  assert(fs.readFileSync(path.join(data, 'matchday-fallback.json')).equals(bytes), 'Fallback differs from selected payload');
  const category = JSON.parse(bytes);
  assert.equal(category.id, 'matchday');
  assert.equal(category.packs.length, 1);
  const pack = category.packs[0];
  assert(pack.items.length > 0 && pack.items.length <= 30);
  assert.equal(new Set(pack.items.map(q => q.id)).size, pack.items.length);
  for (const question of pack.items) {
    assert(typeof question.questionText === 'string' && question.questionText.trim());
    assert(typeof question.sourceQuestionId === 'string' && question.sourceQuestionId);
    if (question.kind === 'multi_choice') assert.equal(question.answers.filter(answer => answer.isCorrect).length, 1, `Invalid answers: ${question.id}`);
    else assert(question.payload && typeof question.payload === 'object', `Missing payload: ${question.id}`);
  }
  if (pack.summary) for (const locale of ['ru', 'en']) assert(typeof pack.summary[locale] === 'string' && pack.summary[locale].trim() && pack.summary[locale].length <= 360, `Invalid ${locale} summary`);
  const manifest = read(path.join(directory, 'content/manifest.json'));
  const entry = manifest.datasets.matchday_fallback;
  assert.equal(entry.path, 'src-assets/data/matchday-fallback.json');
  assert.equal(entry.sha256, pointer.sha256);
  assert.equal(entry.bytes, pointer.bytes);
  assert.equal(entry.rawUrl, 'https://raw.githubusercontent.com/SvytoslavBorisov/WorldFootballQuizNetwork/main/content/src-assets/data/matchday-fallback.json');
  return { file: pointer.file, questions: pack.items.length, title: pack.title, summary: pack.summary };
}

export function buildWorldMatchday({ catalog, home, away, summaryRu, summaryEn, competition, round, roundEn, kickoff, out }) {
  const resolve = input => catalog.packs.find(pack => [pack.id, pack.id.slice(5), pack.title.ru, pack.title.en, ...(pack.aliases ?? [])].some(name => key(name) === key(input)));
  const left = resolve(home), right = resolve(away);
  assert(left && right, 'Choose clubs present in data/catalog.json (Russian/English name or club ID).');
  assert.notEqual(left.id, right.id, 'Choose two different clubs.');
  const summary = { ru: summaryRu?.trim(), en: summaryEn?.trim() };
  for (const locale of ['ru', 'en']) assert(summary[locale] && summary[locale].length <= 360, `Supply a developer-written ${locale} summary, 1–360 characters.`);
  const metadata = [competition && competition !== 'none' ? competition : '', round, kickoff];
  const hasFixture = metadata.some(Boolean);
  if (hasFixture) {
    assert(metadata.every(Boolean), 'Competition, round and kickoff must be supplied together.');
    assert(competitions.has(competition), 'Unknown competition.');
    assert(/T.*(?:Z|[+-]\d\d:\d\d)$/u.test(kickoff) && Number.isFinite(Date.parse(kickoff)), 'Kickoff must be an ISO date with timezone.');
  }
  const id = `mt_${left.id.slice(5)}_${right.id.slice(5)}`;
  const take = pack => selectQuestions(pack, 15, `world-matchday-v2:${id}`).map(question => ({ ...question, id: `${id}__${question.id}`, sourceQuestionId: question.sourceQuestionId ?? question.id }));
  const a = take(left), b = take(right);
  const pack = {
    id, title: { ru: `${left.title.ru} — ${right.title.ru}`, en: `${left.title.en} — ${right.title.en}` }, summary,
    ...(hasFixture ? { fixture: { competition, round: String(round), ...(roundEn ? { roundEn } : {}), kickoff: new Date(kickoff).toISOString(), clubIds: [left.id, right.id] } } : {}),
    items: a.flatMap((question, index) => [question, b[index]]),
  };
  const bytes = Buffer.from(json({ id: 'matchday', title: { ru: 'Битва недели', en: 'Main Event' }, packs: [pack] }));
  const digest = hash(bytes);
  // A changed description/quiz gets a new immutable URL; a cached old payload can
  // never be mistaken for the file named by a newly published pointer.
  const file = `${id}_${digest.slice(0, 16)}.json`;
  const data = path.join(out, 'content/src-assets/data');
  fs.mkdirSync(data, { recursive: true });
  fs.writeFileSync(path.join(data, file), bytes);
  fs.writeFileSync(path.join(data, 'matchday-fallback.json'), bytes);
  fs.writeFileSync(path.join(data, 'current-matchday.json'), json({ version: 1, file, sha256: digest, bytes: bytes.length, title: pack.title, homeClubId: left.id, awayClubId: right.id }));
  fs.writeFileSync(path.join(out, 'content/manifest.json'), json({ version: 1, updatedAt: catalog.generatedAt, datasets: { matchday_fallback: { path: 'src-assets/data/matchday-fallback.json', rawUrl: 'https://raw.githubusercontent.com/SvytoslavBorisov/WorldFootballQuizNetwork/main/content/src-assets/data/matchday-fallback.json', sha256: digest, bytes: bytes.length } }, requiredMediaSlugs: [] }));
  return validateWorldContent(out);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length === 2 && args[0] === '--validate') console.log(JSON.stringify(validateWorldContent(path.resolve(args[1]))));
  else {
    assert(args.length === 2 && args[0] === '--out', 'Use --out <directory> with HOME_TEAM, AWAY_TEAM, SUMMARY_RU, SUMMARY_EN and optional COMPETITION, ROUND, ROUND_EN, KICKOFF environment variables; or --validate <directory>.');
    const env = process.env;
    console.log(JSON.stringify(buildWorldMatchday({ catalog: read(path.join(base, 'data/catalog.json')), home: env.HOME_TEAM, away: env.AWAY_TEAM, summaryRu: env.SUMMARY_RU, summaryEn: env.SUMMARY_EN, competition: env.COMPETITION, round: env.ROUND, roundEn: env.ROUND_EN, kickoff: env.KICKOFF, out: path.resolve(args[1]) })));
  }
}
