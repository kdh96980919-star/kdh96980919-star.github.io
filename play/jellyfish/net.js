/* 클라이언트 네트워킹 — WebSocket 접속, 로컬 예측(prediction),
   서버 재조정(reconciliation), 원격 개체 보간(interpolation).
   물리는 shared/engine.js의 JellyBody를 서버와 똑같이 사용 → 손맛 동일. */
import { CFG, JellyBody, clamp, angLerp } from "./shared/engine.js";

const STEP_MS = 1000 / 60;      // 물리 1스텝 = 1/60초 (서버 틱과 동일)
const HEARTBEAT_MS = 100;       // 입력 무변화여도 최소 이 주기로 재전송
const STEER_EPS = 0.01;         // 이보다 크게 조향이 바뀌면 즉시 전송(rad)
const INTERP_DELAY_MS = 100;    // 원격 개체는 ~2스냅샷 지연 시점을 보간 렌더
const MAX_CORRECTION = 90;      // 재조정 시 시각 오프셋 상한(px)

export const Net = {
  ws: null, myId: null, roomCode: null,
  predicted: null,          // 로컬 플레이어의 예측 JellyBody (서버와 동일 물리)
  pending: [],              // 서버 미확인 입력 링버퍼 [{seq, steer, boost}]
  seq: 0,
  offX: 0, offY: 0,         // 재조정 시각 오차 블렌딩 오프셋 (~100ms에 걸쳐 감쇠)
  acc: 0,
  remotes: new Map(),       // id -> 스냅샷 버퍼 [{at, x, y, heading, mass, boosting}]
  fishTargets: new Map(),   // id -> {x, y}
  starTargets: new Map(),
  decorMeta: null,          // decorRoster (s/hue/rot — 입장 시 1회)
  lastSend: { steer: 1e9, boost: false, at: -1e9 },
  // 게임 쪽에서 등록하는 핸들러
  onRoster: null, onDecor: null, onEvent: null, onRespawned: null, onDisconnect: null,

  connect(nick, roomCode) {
    return new Promise((resolve, reject) => {
      const proto = location.protocol === "https:" ? "wss://" : "ws://";
      const ws = new WebSocket(proto + location.host);
      this.ws = ws;
      let settled = false;
      ws.addEventListener("open", () =>
        ws.send(JSON.stringify({ type: "join", nick, roomCode })));
      ws.addEventListener("message", (e) => {
        let msg;
        try { msg = JSON.parse(e.data); } catch { return; }
        if (!settled && msg.type === "joined") {
          settled = true;
          this.myId = msg.you; this.roomCode = msg.roomCode;
          this._resetPrediction(msg.state);
          resolve({ roomCode: msg.roomCode, state: msg.state });
        } else if (!settled && msg.type === "error") {
          settled = true; reject(new Error(msg.reason)); ws.close();
        } else {
          this._onMsg(msg);
        }
      });
      ws.addEventListener("close", () => {
        if (!settled) { settled = true; reject(new Error("connect-failed")); }
        else if (this.onDisconnect) this.onDisconnect();
      });
      ws.addEventListener("error", () => {});
    });
  },

  _resetPrediction(state) {
    this.predicted = new JellyBody({
      id: this.myId, x: state.x, y: state.y, mass: state.mass,
      heading: state.heading, hue: state.hue, isPlayer: true, name: state.name,
      pulse: state.pulse, boostGauge: state.boostGauge });
    this.pending = [];
    this.offX = 0; this.offY = 0;
    this.acc = 0;
  },

  // 매 rAF 호출. 60Hz 어큐뮬레이터로 물리 스텝(120Hz 화면에서도 속도 동일).
  frame(steer, boost, dtMs) {
    const p = this.predicted;
    if (!p || !p.alive) return;
    this.acc += Math.min(100, dtMs);
    while (this.acc >= STEP_MS) {
      this.acc -= STEP_MS;
      this.seq++;
      this.pending.push({ seq: this.seq, steer, boost });
      if (this.pending.length > 240) this.pending.splice(0, this.pending.length - 240);
      p.updateBoost(boost);
      p.update(steer);
    }
    // 재조정 오프셋 감쇠(스냅이 아니라 ~100ms 블렌딩)
    const k = Math.exp(-dtMs / 40);
    this.offX *= k; this.offY *= k;
    // 입력 전송(변화 시 즉시 + 하트비트)
    const now = performance.now();
    const dSteer = Math.abs(((steer - this.lastSend.steer + Math.PI) % (2 * Math.PI)) - Math.PI);
    if (this.ws && this.ws.readyState === 1 &&
        (dSteer > STEER_EPS || boost !== this.lastSend.boost || now - this.lastSend.at > HEARTBEAT_MS)) {
      this.ws.send(JSON.stringify({ type: "input", seq: this.seq, steer: +steer.toFixed(4), boost }));
      this.lastSend = { steer, boost, at: now };
    }
  },

  // 렌더용 본인 상태 (예측 + 블렌딩 오프셋)
  playerState() {
    const p = this.predicted;
    if (!p) return null;
    return { x: p.x + this.offX, y: p.y + this.offY, heading: p.heading,
             mass: p.mass, boosting: p.boosting, boostGauge: p.boostGauge, alive: p.alive };
  },

  markDead() { if (this.predicted) this.predicted.alive = false; },

  respawn() {
    if (this.ws && this.ws.readyState === 1)
      this.ws.send(JSON.stringify({ type: "respawn" }));
  },

  _onMsg(msg) {
    switch (msg.type) {
      case "snapshot":  this._onSnapshot(msg); break;
      case "roster":    if (this.onRoster) this.onRoster(msg.entities); break;
      case "decorRoster":
        this.decorMeta = msg;
        if (this.onDecor) this.onDecor(msg);
        break;
      case "event":     if (this.onEvent) this.onEvent(msg); break;
      case "respawned":
        this._resetPrediction(msg.state);
        if (this.onRespawned) this.onRespawned(msg.state);
        break;
    }
  },

  _onSnapshot(msg) {
    const at = performance.now();
    const seen = new Set();
    for (const o of msg.others) {
      seen.add(o.id);
      let buf = this.remotes.get(o.id);
      if (!buf) { buf = []; this.remotes.set(o.id, buf); }
      buf.push({ at, x: o.x, y: o.y, heading: o.heading, mass: o.mass, boosting: o.boosting });
      if (buf.length > 5) buf.shift();
    }
    for (const id of this.remotes.keys()) if (!seen.has(id)) this.remotes.delete(id);
    for (const f of msg.fish) this.fishTargets.set(f.id, f);
    for (const s of msg.stars) this.starTargets.set(s.id, s);
    if (msg.you && this.predicted && this.predicted.alive) this._reconcile(msg.you);
  },

  // 서버 권위 상태로 리셋 → 미확인 입력 재적용 → 시각 오차는 오프셋으로 흡수
  _reconcile(you) {
    const p = this.predicted;
    const bx = p.x, by = p.y;
    p.x = you.x; p.y = you.y; p.heading = you.heading; p.mass = you.mass;
    p.boostGauge = you.boostGauge; p.boosting = you.boosting;
    p.boostMult = you.boosting ? CFG.BOOST_MULT : 1;
    p.pulse = you.pulse;
    this.pending = this.pending.filter(i => i.seq > you.lastSeq);
    for (const i of this.pending) { p.updateBoost(i.boost); p.update(i.steer); }
    this.offX = clamp(this.offX + bx - p.x, -MAX_CORRECTION, MAX_CORRECTION);
    this.offY = clamp(this.offY + by - p.y, -MAX_CORRECTION, MAX_CORRECTION);
  },

  // 원격 개체: now-100ms 시점을 스냅샷 버퍼에서 보간
  remoteStateAt(id, now) {
    const buf = this.remotes.get(id);
    if (!buf || !buf.length) return null;
    const t = now - INTERP_DELAY_MS;
    if (t <= buf[0].at) return buf[0];
    for (let i = buf.length - 1; i >= 0; i--) {
      if (buf[i].at <= t) {
        const a = buf[i], b = buf[i + 1];
        if (!b) return a;
        const f = clamp((t - a.at) / (b.at - a.at || 1), 0, 1);
        return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f,
                 heading: angLerp(a.heading, b.heading, f),
                 mass: a.mass + (b.mass - a.mass) * f, boosting: b.boosting };
      }
    }
    return buf[buf.length - 1];
  },
};
