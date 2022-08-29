const test = require('ava');

const common = require('./src/common');
const database = require('./src/database');
const prom = require('./src/prom');
const { formatMail } = require('./src/routing');

async function getTestDatabase(testContext) {
  const db = new database.DatabaseWrapper({
    path: ':memory:',
  });
  await db.sync();
  testContext.teardown(() => db.close());
  return db;
}

test.serial('Database create player/server', async (t) => {
  const db = await getTestDatabase(t);
  await db.checkInPlayers('test', { a: 'foo', b: 'bar' });
  t.is(await db.Player.count(), 2, 'Incorrect player count (2 expected)');
  t.is(await db.Server.count(), 1, 'Incorrect server count (1 expected)');
});

test.serial('Database send player message', async (t) => {
  const db = await getTestDatabase(t);
  await db.checkInPlayers('test', { testXboxId: 'foo', testXboxId2: 'bar' });

  // send two messages
  await db.sendPlayerMessage('testXboxId', 'testXboxId2', 'first');
  t.is(await db.countPlayerMessages('test', 'testXboxId2'), 1, 'Incorrect inbox count (1 exptected)');

  await db.sendPlayerMessage('testXboxId', 'testXboxId2', 'second');
  t.is(await db.countPlayerMessages('test', 'testXboxId2'), 2, 'Incorrect inbox count (2 exptected)');
  t.is(await db.countPlayerMessages('test', 'testXboxId'), 0, 'Incorrect inbox count (0 exptected)');

  // read messages in FIFO
  const msg1 = await db.getPlayerMessage('test', 'testXboxId2');
  t.is(msg1?.message, 'first', 'Did not get mail in FIFO order.');
  t.is(await db.countPlayerMessages('test', 'testXboxId2'), 1, 'Incorrect inbox count (1 exptected)');
  const msg2 = await db.getPlayerMessage('test', 'testXboxId2');
  t.is(msg2?.message, 'second', 'Did not get mail in FIFO order.');
  t.is(await db.countPlayerMessages('test', 'testXboxId2'), 0, 'Incorrect inbox count (0 exptected)');
});

test.serial('Database send server announcement', async (t) => {
  const db = await getTestDatabase(t);
  const _msg = (server, from, message) => new common.Message(
    '', '', from, from, message, { server: server });
  await db.checkInPlayers('test', { testXboxId: 'foo' });
  await db.sendServerMessage(_msg('test', 'foo', 'first'));

  const psm = await db.PlayerServerMessage.findOne();
  psm.update({ lastChecked: new Date(psm.lastChecked - 20_000) });

  // rewind time: https://stackoverflow.com/a/64251213/4001895
  (await db.ServerMessage.findAll()).forEach((msg) => {
    msg.changed('createdAt', true);
    msg.set({ createdAt: new Date(msg.createdAt - 10_000) }, { raw: true });
    msg.save({ silent: true, fields: ['createdAt'] });
  });

  t.is(await db.countPlayerMessages('test', 'testXboxId'), 1, 'Incorrect inbox count (1 exptected)');

  await db.sendServerMessage(_msg('test', 'foo', 'second'));

  t.is(await db.countPlayerMessages('test', 'testXboxId'), 2, 'Incorrect inbox count (2 exptected)');

  t.is((await db.getPlayerMessage('test', 'testXboxId'))?.message,
    'first', 'Did not get mail in FIFO order.');
  t.is(await db.countPlayerMessages('test', 'testXboxId'), 1, 'Incorrect inbox count (1 exptected)');

  t.is((await db.getPlayerMessage('test', 'testXboxId'))?.message,
    'second', 'Did not get mail in FIFO order.');
  t.is(await db.countPlayerMessages('test', 'testXboxId'), 0, 'Incorrect inbox count (0 exptected)');
});

test.serial('Database discord link', async (t) => {
  const db = await getTestDatabase(t);
  await db.checkInPlayers('test', { testXboxId: 'foo' });
  const code = await db.initDiscordLink('testXboxId');
  const result = await db.finalizeDiscordLink(code, 'bar');
  t.is(result, 'foo');
  const code2 = await db.initDiscordLink('testXboxId');
  t.not(code, code2);
});

test.serial('Database Counter Increment', async (t) => {
  t.teardown(prom.reset);
  const db = await getTestDatabase(t);
  const cntr = new prom.Counter({
    name: 'test', help: 'help', labelNames: ['foo', 'bar'] });
  const fields = { 'foo': 'a', 'bar': 'b' };
  await cntr.init({ web: { enabled: false, counterDelay: 10 } }, db);

  t.is(await cntr.get(fields), undefined);

  const p = cntr.inc(fields);
  t.is(await cntr.get(fields), 0);

  await p;
  t.is(await cntr.get(fields), 1);
});

test.serial('Database Counter Reload', async (t) => {
  t.teardown(prom.reset);
  const db = await getTestDatabase(t);
  const setup = { name: 'test', help: 'help', labelNames: ['foo', 'bar'] };
  const config = { web: { enabled: false, counterDelay: 0 } };
  const fields = { 'foo': 'a', 'bar': 'b' };

  let cntr = new prom.Counter(setup);
  await cntr.init(config, db);

  await cntr.inc(fields);
  cntr.delete();

  cntr = new prom.Counter(setup);
  await cntr.init(config, db);

  t.is(await cntr.get(fields), 1);
  await cntr.inc(fields);
  cntr.delete();

  cntr = new prom.Counter(setup);
  await cntr.init(config, db);
  t.is(await cntr.get(fields), 2);
});

test.serial('Format Mail', t => {
  function _unchanged(msg) {
    t.is(formatMail(msg), msg);
  }
  _unchanged('a b c');
  // newline
  _unchanged('a b\nc');
  // headline not set
  t.is(formatMail('a b c', { headline: true }), '');
  // headline set
  t.is(formatMail('a **b** c', { headline: true }), 'b');
  // multiple headlines
  t.is(formatMail('a **b** **c d**', { headline: true }), 'b c d');
  // multiple headlines, multiple lines
  t.is(formatMail('a **b**\n**c d**', { headline: true }), 'b\nc d');
  // headline spanning multiple lines
  t.is(formatMail('a **b\nc d**', { headline: true }), 'b\nc d');
  // headline with unmatched closing tag
  t.is(formatMail('a **b\nc d', { headline: true }), 'b\nc d');
});