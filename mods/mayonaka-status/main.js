// The shipped workspace-status with the agent count swapped for the current agent's session: its program icon and title,
// and the shown machine's CPU and memory on the right.
// "Current" is the focused agent, else the one in the shown tab that changed last, so an editor pane beside it keeps it shown.
import { View, div, svg, image } from "gpui-kit";
import { h_flex } from "gpui-base";
import { spaces, agents, focused, exec, theme, run, window, keys } from "herdr";

// Agents prefix their title with a spinner or status glyph (Claude Code's ✳); the agents list strips it the same way.
const clean = (s) => (s ?? "").replace(/^[^\p{L}\p{N}]+/u, "").trim();

function current() {
  const list = agents(), tab = focused()?.tab;
  return list.find((a) => a.focused) ?? list.filter((a) => a.tab === tab).sort((a, b) => b.seq - a.seq)[0] ?? null;
}

// Sampled on the machine the shown space lives on, printing "cpu% usedBytes totalBytes". macOS: iostat over one second
// (top -l 2 costs a second of CPU itself) and vm_stat, with memory counted as Activity Monitor does (app + wired +
// compressed, not file cache). Linux: two reads of /proc/stat a second apart and MemAvailable.
const STATS = String.raw`if [ "$(uname)" = Darwin ]; then
  cpu=$(iostat -n 0 -c 2 -w 1 | awk 'END { print 100 - $3 }')
  vm_stat | awk -v cpu="$cpu" -v ps="$(sysctl -n hw.pagesize)" -v total="$(sysctl -n hw.memsize)" '
    /^Anonymous pages/ { a = $3 } /^Pages purgeable/ { p = $3 } /^Pages wired down/ { w = $4 } /occupied by compressor/ { c = $5 }
    END { printf "%d %.0f %.0f\n", cpu, (a - p + w + c) * ps, total }'
else
  a=$(head -n 1 /proc/stat); sleep 1; b=$(head -n 1 /proc/stat)
  cpu=$(printf '%s\n%s\n' "$a" "$b" | awk 'NR == 1 { for (i = 2; i <= 9; i++) t1 += $i; i1 = $5 + $6 } NR == 2 { for (i = 2; i <= 9; i++) t2 += $i; i2 = $5 + $6 } END { printf "%d", (t2 - t1 - (i2 - i1)) * 100 / (t2 - t1) + 0.5 }')
  awk -v cpu="$cpu" '/^MemTotal/ { t = $2 } /^MemAvailable/ { m = $2 } END { printf "%d %.0f %.0f\n", cpu, (t - m) * 1024, t * 1024 }' /proc/meminfo
fi`;
const REFRESH = 5000;

const gb = (bytes) => { const g = bytes / 2 ** 30; return g < 10 ? g.toFixed(1) : Math.round(g); };

export default class MayonakaStatus extends View {
  init(_props, cx) {
    this.stats = new Map();
    this.busy = new Set();
    cx.timer.every(REFRESH, (cx) => cx.notify());
  }

  // Render asks, this decides: one sample in flight per machine, the next once the last is REFRESH old. A sample takes
  // a second, so a success is stamped when it started (a steady period) and a failure when it ended (an unreachable
  // machine that times out isn't retried back to back). A failure leaves nothing to show.
  poll(machine, cx) {
    const key = machine ?? "", started = Date.now();
    if (this.busy.has(key) || started - (this.stats.get(key)?.at ?? 0) < REFRESH - 500) return;
    this.busy.add(key);
    cx.spawn(async (cx) => {
      let stat = null;
      try {
        const r = await exec("sh", ["-c", STATS], { on: machine, timeout: 10000 });
        const [cpu, used, total] = r.stdout.trim().split(/\s+/).map(Number);
        if (r.code === 0 && Number.isFinite(cpu) && used >= 0 && total > 0) stat = { cpu: Math.round(Math.min(100, Math.max(0, cpu))), used, total, at: started };
      } catch {}
      this.stats.set(key, stat ?? { at: Date.now() });
      this.busy.delete(key);
      cx.notify();
    });
  }

  // The palette key as actually bound, not a hardcoded one; without a
  // binding the hint stays useful ("commands") instead of lying.
  hint() {
    const mac = window()?.platform === "macos";
    const mod = { cmd: mac ? "⌘" : "Ctrl+", ctrl: mac ? "⌃" : "Ctrl+", shift: mac ? "⇧" : "Shift+", alt: mac ? "⌥" : "Alt+", option: mac ? "⌥" : "Alt+" };
    const b = keys().find((k) => k.section === "global" && k.action === "app.palette");
    const parts = b && b.keys.endsWith("--") ? [...b.keys.slice(0, -2).split("-"), "-"] : b?.keys.split("-");
    const key = parts && parts.map((p) => mod[p.toLowerCase()] ?? p.toUpperCase()).join("");
    return key ? `${key}  commands` : "commands";
  }

  render(cx) {
    const t = theme();
    const space = spaces().find((s) => s.active);
    const agent = current(), name = clean(agent?.title) || agent?.program?.name || "";
    const p = agent?.program;
    const machine = space?.machine ?? null, stat = this.stats.get(machine ?? "");
    this.poll(machine, cx);
    const label = (icon, text) => h_flex().gap(6).items_center().child(svg(`mods/mayonaka-status/${icon}.svg`).size(13)).child(text);
    return h_flex().size_full().px(14).gap(16).items_center().bg(t.chrome).border_t(1).border_color(t.border).text_size(11.8).text_color(t.muted)
      .child(label(space?.machine ? "server" : "monitor", space?.machine ?? "This computer"))
      .when(Boolean(space?.branch), (el) => el.child(label("branch", space.branch)))
      .when(Boolean(name), (el) => el.child(h_flex().flex_1().min_w(0).gap(6).items_center()
        .when(Boolean(p?.icon), (row) => row.child(p.tint ? svg(p.icon).size(13).flex_none() : image(p.icon).w(13).h(13).flex_none()))
        .child(div().min_w(0).truncate().child(name))))
      .when(!name, (el) => el.child(div().flex_1()))
      .when(Boolean(stat?.total), (el) => el.child(h_flex().flex_none().gap(12).child(`CPU ${stat.cpu}%`).child(`MEM ${gb(stat.used)}/${gb(stat.total)}G`)))
      .child(div().id("palette").flex_none().text_color(t.dim).on_click(() => run("app.palette")).child(this.hint()));
  }
}
