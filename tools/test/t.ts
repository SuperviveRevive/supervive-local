// Minimal test helper shared by the gates.
export class T {
  pass = 0; fail = 0; fails: string[] = [];
  constructor(public name: string) {}
  ok(label: string, cond: unknown, detail = "") {
    if (cond) this.pass++;
    else { this.fail++; this.fails.push(`${label}${detail ? ` — ${String(detail).slice(0, 300)}` : ""}`); console.log(`  FAIL ${label}${detail ? ` — ${String(detail).slice(0, 300)}` : ""}`); }
  }
  eq(label: string, got: unknown, want: unknown) {
    const g = JSON.stringify(got), w = JSON.stringify(want);
    this.ok(label, g === w, `got ${g}, want ${w}`);
  }
  done(): never {
    console.log(`${this.name}: ${this.pass}/${this.pass + this.fail}${this.fail ? " FAIL" : " PASS"}`);
    process.exit(this.fail ? 1 : 0);
  }
}
