/* 솔로 봇전 — 서버 없이 브라우저 안에서 Room 시뮬레이션을 60Hz로 구동.
   net.js(Net)와 동일한 인터페이스: 흐느적.html이 활성 net 핸들만 바꿔 끼우면 됨.
   예측·보간이 필요 없으므로(지연 0) 몸체 상태를 그대로 읽는다. */
import { Room, bodyState } from "./shared/room.js";

const STEP_MS = 1000 / 60;      // 물리 1스텝 = 1/60초 (서버 틱과 동일)

export const LocalNet = {
  room: null, player: null, myId: null, roomCode: null,
  acc: 0, seq: 0,
  fishTargets: new Map(),
  starTargets: new Map(),
  decorMeta: null,
  // 게임 쪽에서 등록하는 핸들러 (Net과 동일)
  onRoster: null, onDecor: null, onEvent: null, onRespawned: null, onDisconnect: null,

  get predicted() { return this.player ? this.player.body : null; },

  connect(nick) {
    const room = new Room("SOLO");
    const player = room.addPlayer(null, String(nick || "").trim().slice(0, 10) || "나");
    this.room = room; this.player = player;
    this.myId = player.id; this.roomCode = null;
    this.acc = 0;
    this.fishTargets.clear(); this.starTargets.clear();
    room.tick();   // 봇 스폰 — 서버라면 이미 돌고 있던 방에 입장하는 셈
    const state = bodyState(player.body);
    return new Promise((resolve) => {
      resolve({ roomCode: null, state });
      // 서버 흐름과 동일하게 decorRoster·roster는 joined 처리 뒤에 도착
      setTimeout(() => {
        this.decorMeta = room.decorRosterMsg();
        if (this.onDecor) this.onDecor(this.decorMeta);
        this._sync();
      }, 0);
    });
  },

  // 매 rAF 호출. 60Hz 어큐뮬레이터로 물리 스텝(120Hz 화면에서도 속도 동일).
  frame(steer, boost, dtMs) {
    const b = this.player && this.player.body;
    if (!b || !b.alive) return;
    this.acc += Math.min(100, dtMs);
    let ticked = false;
    while (this.acc >= STEP_MS) {
      this.acc -= STEP_MS;
      this.player.input = { seq: ++this.seq, steer, boost };
      this.room.tick();
      ticked = true;
      if (!this.player.body.alive) { this.acc = 0; break; }   // 사망 → 즉시 이벤트 전달
    }
    if (ticked) this._sync();
  },

  // 방 상태 → 콜백·타깃 반영 (서버의 roster/event/snapshot 브로드캐스트에 대응)
  _sync() {
    const room = this.room;
    if (room.rosterDirty) {
      room.rosterDirty = false;
      if (this.onRoster) this.onRoster(room.rosterMsg().entities);
    }
    if (room.pendingEvents.length) {
      const evs = room.pendingEvents;
      room.pendingEvents = [];
      if (this.onEvent) for (const ev of evs) this.onEvent(ev);
    }
    for (const f of room.decor.fish) this.fishTargets.set(f.id, { x: f.x, y: f.y });
    for (const s of room.decor.stars) this.starTargets.set(s.id, { x: s.x, y: s.y });
  },

  // 렌더용 본인 상태 (로컬 시뮬레이션이라 보정 오프셋 없음)
  playerState() {
    const b = this.player && this.player.body;
    if (!b) return null;
    return { x: b.x, y: b.y, heading: b.heading, mass: b.mass,
             boosting: b.boosting, boostGauge: b.boostGauge, alive: b.alive };
  },

  markDead() {},   // 사망은 tick에서 이미 반영됨 — Net 인터페이스 맞춤 no-op

  respawn() {
    const p = this.player;
    if (!p || (p.body && p.body.alive)) return;   // 살아있으면 무시 (서버와 동일)
    this.room.respawnPlayer(p);
    this.acc = 0;
    this._sync();
    if (this.onRespawned) this.onRespawned(bodyState(p.body));
  },

  // 원격 개체 = 같은 프로세스의 봇 몸체를 그대로 읽음 (보간 불필요)
  remoteStateAt(id) {
    if (!this.room) return null;
    for (const b of this.room.bots) if (b.id === id) return b;
    return null;
  },
};
