import { listSessions, type SessionMeta } from '../session/store.js';
import { SelectList, matchesKey, truncateToWidth } from '../vendor/pi/tui/index.js';
import type { Component } from '../vendor/pi/tui/tui.js';

export class SessionPicker implements Component {
  all = false;
  query = '';
  private list!: SelectList;
  private items: SessionMeta[];
  constructor(home: string, private readonly cwd: string, private readonly done: (id?: string) => void, private readonly changed: () => void) {
    this.items = listSessions(home); this.rebuild();
  }
  private rebuild() {
    const query = this.query.toLocaleLowerCase();
    const items = this.items.filter((m) => (this.all || m.cwd === this.cwd) && [m.title, m.cwd, m.id, m.lastActivityAt ?? ''].join(' ').toLocaleLowerCase().includes(query));
    this.list = new SelectList(items.map((m) => ({ value: m.id, label: `${m.title || '空会话'} · ${m.id.slice(0, 8)}`,
      description: `${m.lastActivityAt ?? '尚无工作'} · ${m.cwd}` })), 10,
    { selectedPrefix: (s) => s, selectedText: (s) => s, description: (s) => s, scrollInfo: (s) => s, noMatch: () => '没有匹配的会话' });
    this.list.onSelect = (item) => this.done(item.value); this.list.onCancel = () => this.done();
    this.changed();
  }
  handleInput(data: string) {
    if (data.includes('\x1b[200~')) {
      this.query += data.replace(/\x1b\[(?:200|201)~/g, '').replace(/[\r\n]/g, ' '); this.rebuild(); return;
    }
    if (matchesKey(data, 'tab')) { this.all = !this.all; this.rebuild(); }
    else if (matchesKey(data, 'backspace')) { this.query = Array.from(this.query).slice(0, -1).join(''); this.rebuild(); }
    else if (!/[\x00-\x1f\x7f]/.test(data)) { this.query += data; this.rebuild(); }
    else { this.list.handleInput(data); this.changed(); }
  }
  render(width: number) { return [truncateToWidth(`选择调查 · ${this.all ? '全部' : '当前目录'}（Tab 切换）`, width),
    truncateToWidth(`筛选：${this.query} · ↑↓ 选择 · Enter 恢复 · Esc 返回`, width), ...this.list.render(width)]; }
  invalidate() { this.list.invalidate(); }
}
