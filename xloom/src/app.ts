import { configSecrets, loadConfig, xloomHome } from './config.js';
import { redactor } from './log.js';
import { createAgent } from './runtime/agent.js';
import { canonicalCwd, createSession, recentSession, type Session } from './session/store.js';
import { resumeSession } from './session/resume.js';
import { XLoomTui } from './tui/app.js';
import { CaseLoop } from './case/loop.js';
import type { BlackboardStore } from './case/store.js';

export type StartMode = { mode: 'new' | 'continue' | 'pick' } | { mode: 'resume'; id: string };
export async function startApp(options: StartMode = { mode: 'new' }) {
  const home = xloomHome(), config = loadConfig(home), cwd = canonicalCwd(process.cwd());
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('xloom 交互启动需要 TTY 终端。请在终端直接运行 xloom。');
  const view = new XLoomTui(undefined, redactor(...configSecrets(config)));
  let loop: CaseLoop | undefined, quitting = false, requestExit!: () => void;
  const exited = new Promise<void>((resolve) => { requestExit = () => { quitting = true; loop?.cancel('会话退出'); resolve(); }; });
  const choose = () => Promise.race([view.chooseSession(home, loop?.session.metadata.cwd ?? cwd), exited.then(() => undefined)]);
  const assemble = (session: Session, store?: BlackboardStore) => {
    const isCurrent = () => loop?.session === session;
    const agent = createAgent({ config, home, session,
      onEvent: (event) => { if (isCurrent()) view.onEvent(event); }, onState: () => { if (isCurrent()) view.refreshStatus(); } });
    return new CaseLoop(agent, config, (text) => { if (isCurrent()) view.notice(text); }, () => { if (isCurrent()) view.refreshStatus(); }, store);
  };
  const switchSession = async () => {
    const old = loop!;
    await old.pauseAndWait(); old.session.assertSaved();
    const id = await choose();
    if (!id || quitting || id === old.session.metadata.id) return;
    let opened: ReturnType<typeof resumeSession> | undefined;
    try {
      opened = resumeSession(home, id, config);
      const next = assemble(opened.session, opened.store);
      loop = next; view.bind(next, requestExit, switchSession); view.restoreHistory(next);
    } catch (e) {
      loop = old; view.bind(old, requestExit, switchSession);
      opened?.session.release(); throw e;
    }
    await old.close();
  };
  const onSignal = () => requestExit();
  process.on('SIGTERM', onSignal); process.on('SIGINT', onSignal); process.on('SIGHUP', onSignal);
  try {
    view.start();
    let id: string | undefined;
    if (options.mode === 'continue') id = recentSession(home, cwd);
    else if (options.mode === 'resume') id = options.id;
    else if (options.mode === 'pick') { id = await choose(); if (!id || quitting) return; }
    const opened = id ? resumeSession(home, id, config) : { session: createSession(cwd, config, home), store: undefined };
    try { loop = assemble(opened.session, opened.store); } catch (e) { opened.session.release(); throw e; }
    view.bind(loop, requestExit, switchSession);
    if (id) view.restoreHistory(loop);
    await exited;
  } finally {
    try { await loop?.close(); }
    finally {
      await view.stop();
      process.off('SIGTERM', onSignal); process.off('SIGINT', onSignal); process.off('SIGHUP', onSignal);
      process.stdin.pause();
    }
  }
  if (loop) process.stdout.write(`会话已保存：${loop.session.dir}\n`);
}
