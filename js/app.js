/**
 * Mesh Game — Application Shell
 *
 * UI state machine, transport/lobby binding, turn coordination.
 * All game logic lives in engine/*.js — swap the engine to change games.
 */

import { Renderer } from './engine/artillery/renderer.js';
import { ArtilleryEngine } from './engine/artillery/game.js';
import { MockTransport } from './transport.js';
import { MeshtasticAdapter } from './transport/meshtastic/adapter.js';
import { Lobby } from './lobby.js';
import { turnPacket, resultPacket } from './protocol.js';
import { makeGameId } from './utils/hash.js';

// ============================================================
// States
// ============================================================
const STATE = {
  INIT: 'init',
  CONNECT: 'connect',
  LOBBY: 'lobby',
  WAITING_OPPONENT: 'waiting_opponent',
  GAME_START: 'game_start',
  MY_TURN: 'my_turn',
  ANIMATING: 'animating',
  OPPONENT_TURN: 'opponent_turn',
  WATCHING: 'watching',
  GAME_OVER: 'game_over',
};

const GAME_STATES = [STATE.MY_TURN, STATE.ANIMATING, STATE.OPPONENT_TURN, STATE.WATCHING];

// ============================================================
// Timing
// ============================================================
const OFFER_HEARTBEAT_S = 8;
const TURN_RESEND_S = 5;
const MAX_RESENDS = 3;

// ============================================================
// App
// ============================================================
class MeshGame {
  constructor() {
    this.canvas = document.getElementById('game-canvas');
    this.renderer = new Renderer(this.canvas);

    // Engine (swappable — currently artillery)
    this.engine = null;

    // State
    this.state = STATE.INIT;
    this.nodeId = null;
    this.nickname = 'Player';
    this.transport = null;
    this.lobby = null;

    // Match
    this.openGameId = null;
    this.opponentNode = null;
    this.opponentNick = null;
    this.localIsP1 = true;
    this.gameSeed = 0;
    this.gameType = 'artillery';

    // Network
    this.lastOfferAt = 0;
    this.pendingTurnPacket = null;
    this.turnResendCount = 0;
    this.turnResendTimer = null;
    this.seenPackets = new Set();

    // Connection
    this.lastPacketFromOpponent = 0;
    this.connectionLost = false;

    // Loop
    this._lastTime = 0;
    this._rafId = null;
    this._postImpactTimer = null;
    this._startGameTimer = null;
    this._offerHeartbeatTimer = null;
    this.lastActivityTime = 0;
    this._activityLost = false;
    this._waitingAccept = false;

    // UI
    this.overlay = document.getElementById('overlay');
    this.hud = document.getElementById('hud');

    this._bindUI();
    this._transition(STATE.CONNECT);
  }

  // ==========================================================
  // State Machine
  // ==========================================================
  _transition(newState, data = {}) {
    const prev = this.state;
    console.log(`[State] ${prev} → ${newState}`, data);
    this.state = newState;

    document.querySelectorAll('.screen').forEach(s => s.classList.add('hidden'));

    const isGameState = GAME_STATES.includes(newState);
    this.hud.classList.toggle('hidden', !isGameState);
    this.overlay.style.pointerEvents = isGameState ? 'none' : 'auto';
    this.overlay.style.background = isGameState ? 'none' : 'rgba(10, 10, 30, 0.85)';
    this.overlay.style.backdropFilter = isGameState ? 'none' : 'blur(4px)';

    switch (newState) {
      case STATE.CONNECT:
        this._showScreen('screen-connect');
        document.getElementById('connect-status').textContent = '';
        break;

      case STATE.LOBBY:
        this._showScreen('screen-lobby');
        document.getElementById('lobby-nick').textContent = this.nickname;
        document.getElementById('lobby-node').textContent = this.nodeId || '';
        document.getElementById('lobby-status').textContent = '';
        this._refreshGameList();
        break;

      case STATE.WAITING_OPPONENT:
        this._showScreen('screen-waiting');
        document.getElementById('waiting-game-id').textContent = `Game: ${data.gameId || ''}`;
        this._startOfferHeartbeat();
        break;

      case STATE.GAME_START: {
        this._showScreen('screen-game-start');
        document.getElementById('start-vs').textContent = `${this.nickname} vs ${data.opponent || '???'}`;
        document.getElementById('start-seed').textContent = data.seed || 0;
        document.getElementById('start-turn-info').textContent = data.myTurn ? 'You go first!' : 'Opponent goes first.';

        // Init engine
        this._createEngine();
        const p1Name = this.localIsP1 ? this.nickname : data.opponent;
        const p2Name = this.localIsP1 ? data.opponent : this.nickname;
        this.engine.init(data.seed, p1Name, p2Name);

        // Reset tracking
        this.lastPacketFromOpponent = performance.now() / 1000;
        this.connectionLost = false;

        this._updateHUD();

        this._startGameTimer = setTimeout(() => {
          document.getElementById('screen-game-start').classList.add('hidden');
          this._transition(data.myTurn ? STATE.MY_TURN : STATE.OPPONENT_TURN);
        }, 2000);
        break;
      }

      case STATE.MY_TURN:
        this._enableControls(true);
        document.getElementById('turn-status').textContent = '🎯 Your turn!';
        this.engine.generateWind?.();
        this._updateHUD();
        break;

      case STATE.ANIMATING:
        this._enableControls(false);
        document.getElementById('turn-status').textContent = '💥 Firing...';
        break;

      case STATE.OPPONENT_TURN:
        this._enableControls(false);
        document.getElementById('turn-status').textContent = '⏳ Opponent\'s turn...';
        break;

      case STATE.WATCHING:
        this._enableControls(false);
        document.getElementById('turn-status').textContent = '👀 Watching...';
        break;

      case STATE.GAME_OVER:
        this.hud.classList.add('hidden');
        this.overlay.style.pointerEvents = 'auto';
        this.overlay.style.background = 'rgba(10, 10, 30, 0.85)';
        this.overlay.style.backdropFilter = 'blur(4px)';
        this._showScreen('screen-game-over');
        document.getElementById('game-over-title').textContent =
          data.forfeit ? '🏳️ Opponent surrendered!' :
          data.won ? '🏆 Victory!' : data.draw ? '🤝 Draw!' : '💀 Defeat';
        document.getElementById('game-over-stats').textContent =
          data.forfeit ? `${data.winner} wins by forfeit` :
          data.draw ? 'It\'s a draw!' : `${data.winner} wins!`;
        this._cleanupGame();
        break;
    }
  }

  _showScreen(id) {
    document.querySelectorAll('.screen').forEach(s => s.classList.add('hidden'));
    document.getElementById(id).classList.remove('hidden');
  }

  _enableControls(enabled) {
    document.getElementById('btn-fire').disabled = !enabled;
    document.getElementById('btn-forfeit').disabled = false; // always available in-game
    document.getElementById('angle-slider').disabled = !enabled;
    document.getElementById('power-slider').disabled = !enabled;
  }

  // ==========================================================
  // Engine factory
  // ==========================================================
  _createEngine() {
    switch (this.gameType) {
      case 'artillery':
        this.engine = new ArtilleryEngine();
        break;
      // case 'seabattle': this.engine = new SeaBattleEngine(); break;
      default:
        this.engine = new ArtilleryEngine();
    }
  }

  // ==========================================================
  // Transport
  // ==========================================================
  _initMockTransport() {
    this.nickname = 'Player_' + Math.floor(Math.random() * 1000);
    const transport = new MockTransport();
    this.nodeId = transport.nodeId;
    this._setupTransport(transport);
    this._transition(STATE.LOBBY);
  }

  async _connectMeshtastic(type, options = {}) {
    const status = document.getElementById('connect-status');
    status.textContent = `Connecting via ${type}...`;

    try {
      const adapter = await MeshtasticAdapter.create(type, options);
      // Use short hex from nodeId as default nick (strip ! prefix, 8 chars max)
      this.nickname = adapter.nodeId.replace(/^!/, '').substring(0, 8);
      this.nodeId = adapter.nodeId;
      this._setupTransport(adapter);
      this.start();
      this._transition(STATE.LOBBY);
    } catch (e) {
      if (e.name === 'NotFoundError' && e.message.includes('No port selected')) {
        status.textContent = 'No port selected — plug in the device and try again';
      } else {
        status.textContent = `Connection failed: ${e.message}`;
      }
      console.error('[Meshtastic]', e);
    }
  }

  _setupTransport(transport) {
    this.transport = transport;
    this.lobby = new Lobby(transport, this.nodeId, this.nickname);
    transport.onMessage(p => this._handlePacket(p));
    transport.onConnectionChange(connected => {
      if (!connected && this.state !== STATE.CONNECT) {
        document.getElementById('lobby-status').textContent = '⚠ Connection lost';
      }
    });
  }

  // ==========================================================
  // Packets
  // ==========================================================
  _handlePacket(packet) {
    const dedupeKey = `${packet.t}|${packet.g}|${packet.s}|${packet.m}`;
    if (this.seenPackets.has(dedupeKey)) return;
    this.seenPackets.add(dedupeKey);

    if (packet.s === this.opponentNode) {
      this.lastPacketFromOpponent = performance.now() / 1000;
      if (this.connectionLost) { this.connectionLost = false; this._updateConnectionDot(); }
    }

    console.log('[Packet]', packet.t, packet);

    switch (packet.t) {
      case 'join':   this._onJoin(packet); break;
      case 'accept': this._onAccept(packet); break;
      case 'turn':   this._onTurn(packet); break;
      case 'ping':   this._onPing(packet); break;
      case 'forfeit': this._onForfeit(packet); break;
      case 'cancel':  this._onCancel(packet); break;
      case 'result':  this._onResult(packet); break;
    }
  }

  _onJoin(packet) {
    if (this.state !== STATE.WAITING_OPPONENT || packet.g !== this.openGameId) return;
    this.opponentNode = packet.s;
    this.opponentNick = packet.n;
    this.localIsP1 = true;
    this.lastPacketFromOpponent = performance.now() / 1000;
    this.gameSeed = Math.floor(Math.random() * 2147483647);

    // Retry accept 3 times — ensure joiner receives it
    const sendAccept = (n) => {
      this.lobby.acceptJoin(this.openGameId, packet.s, this.gameSeed, 1, this.gameType);
      if (n > 1) setTimeout(() => sendAccept(n - 1), 2000);
    };
    sendAccept(3);

    this.lobby.closeOffer(this.openGameId);
    this.openGameId = null;

    this._transition(STATE.GAME_START, {
      seed: this.gameSeed, myTurn: true, opponent: this.opponentNick,
    });
  }

  _onAccept(packet) {
    if (this.state !== STATE.LOBBY && this.state !== STATE.WAITING_OPPONENT) return;
    this._waitingAccept = false; // got the accept, stop waiting
    this.opponentNode = packet.s;
    this.opponentNick = packet.n;
    this.localIsP1 = false;
    this.gameSeed = packet.d.seed || 0;
    this.gameType = packet.d.game || 'artillery';
    this.lastPacketFromOpponent = performance.now() / 1000;

    this._transition(STATE.GAME_START, {
      seed: this.gameSeed,
      myTurn: (packet.d.pw || 1) === 2,
      opponent: this.opponentNick,
    });
  }

  _onTurn(packet) {
    if (!this.engine || this.engine.outcome) return;
    if (this.state !== STATE.OPPONENT_TURN) {
      console.log('[Turn] Not OPPONENT_TURN, ignoring');
      return;
    }

    this.lobby.sendPing(packet.g, packet.s, packet.m);

    const d = packet.d;

    // Delegate to engine — same physics as local fire
    const playerIdx = this.localIsP1 ? 1 : 0; // opponent index
    this.engine.applyOpponentAction(playerIdx, { angle: d.a, powerPct: d.p, wind: d.w });

    this._clearTurnResend();
    this._updateHUD();
    this._transition(STATE.WATCHING);
  }

  _onPing(packet) {
    if (this.pendingTurnPacket && packet.d?.m === this.pendingTurnPacket.m) {
      console.log('[Ping] ACK, stopping resend');
      this._clearTurnResend();
    }
  }

  _onForfeit(_packet) {
    if (!this.engine) return;
    this.engine.forfeit(this.localIsP1 ? 'p2' : 'p1');
    this._transition(STATE.GAME_OVER, { won: true, draw: false, winner: this.nickname, forfeit: true });
  }

  _onCancel(_packet) {
    if (this.state === STATE.OPPONENT_TURN || this.state === STATE.WATCHING) {
      this._transition(STATE.GAME_OVER, { won: true, draw: false, winner: this.nickname, forfeit: true });
    }
  }

  _onResult(packet) {
    if (!this.engine) return;
    const w = packet.d.w;
    const won = (w === 'p1' && this.localIsP1) || (w === 'p2' && !this.localIsP1) || w === 'draw';
    this._transition(STATE.GAME_OVER, {
      won: won && w !== 'draw', draw: w === 'draw',
      winner: w === 'draw' ? 'Draw' : (won ? this.nickname : this.opponentNick),
    });
  }

  // ==========================================================
  // Lobby
  // ==========================================================
  _testTx() {
    const testPacket = {
      a: 'mg', v: 1, t: 'p', g: 'TEST', s: this.nodeId,
      n: this.nickname, m: '0000', d: { test: 'tx_check' },
    };
    // Send 3 times with 1.5s gap to overcome LoRa packet loss
    const send = (attempt) => {
      console.log('[TestTX] Sending test packet, attempt', attempt + 1, 'of 3...');
      this.transport.sendPublic(testPacket);
      document.getElementById('lobby-status').textContent =
        `📡 Test packet sent (${attempt + 1}/3) — check other node`;
      if (attempt < 2) {
        setTimeout(() => send(attempt + 1), 1500);
      } else {
        setTimeout(() => {
          if (document.getElementById('lobby-status').textContent.includes('Test packet')) {
            document.getElementById('lobby-status').textContent = '';
          }
        }, 3000);
      }
    };
    send(0);
  }

  _openGame() {
    if (this.state !== STATE.LOBBY) return; // prevent double-click
    const gameId = makeGameId();
    this.lobby.openGame(gameId, this.gameType);
    this.openGameId = gameId;
    this.lastOfferAt = performance.now() / 1000;
    this._transition(STATE.WAITING_OPPONENT, { gameId });
  }

  _joinGame(gameId, hostNodeId) {
    // Retry join 3 times to overcome packet loss
    const send = (n) => {
      this.lobby.joinGame({ gameId, nodeId: hostNodeId });
      if (n > 1) setTimeout(() => send(n - 1), 2000);
    };
    send(3);
    this.opponentNode = hostNodeId;
    this.lastPacketFromOpponent = 0; // reset timer
    this._waitingAccept = true;       // track that we're waiting for accept
    document.getElementById('lobby-status').textContent = 'Join sent, waiting for host...';
  }

  _refreshGameList() {
    const games = this.lobby?.listGames() || [];
    const container = document.getElementById('games-list');
    if (games.length === 0) {
      container.innerHTML = '<p class="empty">No open games. Create one or refresh.</p>';
      return;
    }
    container.innerHTML = games.map((g, i) => `
      <div class="game-entry">
        <span class="game-host">${g.nick || g.nodeId.slice(0, 8)}</span>
        <span class="game-id">${g.gameId}</span>
        <button class="btn btn-join" data-gameid="${g.gameId}" data-host="${g.nodeId}">Join</button>
      </div>
    `).join('');
    container.querySelectorAll('.btn-join').forEach(btn => {
      btn.addEventListener('click', () => this._joinGame(btn.dataset.gameid, btn.dataset.host));
    });
  }

  _startOfferHeartbeat() {
    this._offerHeartbeatTimer = setInterval(() => {
      if (this.state === STATE.WAITING_OPPONENT && this.openGameId) {
        this.lobby.openGame(this.openGameId, this.gameType);
      }
    }, OFFER_HEARTBEAT_S * 1000);
  }

  // ==========================================================
  // Game actions
  // ==========================================================
  fire() {
    if (this.state !== STATE.MY_TURN) return;
    if (!this.engine || this.engine.outcome || this.engine.isAnimating()) return;

    const angle = parseInt(document.getElementById('angle-slider').value);
    const powerPct = parseInt(document.getElementById('power-slider').value);

    const playerIdx = this.localIsP1 ? 0 : 1;
    const data = this.engine.playerAction(playerIdx, { angle, powerPct });
    if (!data) return;

    // Send immediately
    this._sendTurnPacket(data);
    this._transition(STATE.ANIMATING);
  }

  _sendTurnPacket(data) {
    const packet = turnPacket(this._getGameId(), this.nodeId, this.nickname,
                               data.round, data.angle, data.powerPct, data.wind, '', '');
    console.log('[Turn] Sending round:', data.round, 'angle:', data.angle, 'power:', data.powerPct);
    this.pendingTurnPacket = packet;
    this.turnResendCount = 0;
    this._sendToOpponent();
  }

  _sendToOpponent() {
    if (!this.pendingTurnPacket || !this.opponentNode) return;
    this.transport.sendDirect(this.opponentNode, this.pendingTurnPacket);
    this.turnResendCount++;
    if (this.turnResendTimer) clearTimeout(this.turnResendTimer);
    this.turnResendTimer = setTimeout(() => this._resendTick(), TURN_RESEND_S * 1000);
  }

  _resendTick() {
    if (!this.pendingTurnPacket || !this.opponentNode) return;
    if (this.turnResendCount >= MAX_RESENDS) return;
    console.log('[Turn] Resending...');
    this.transport.sendDirect(this.opponentNode, this.pendingTurnPacket);
    this.turnResendCount++;
    if (this.turnResendCount < MAX_RESENDS) {
      this.turnResendTimer = setTimeout(() => this._resendTick(), TURN_RESEND_S * 1000);
    }
  }

  _clearTurnResend() {
    if (this.turnResendTimer) { clearTimeout(this.turnResendTimer); this.turnResendTimer = null; }
    this.pendingTurnPacket = null;
    this.turnResendCount = 0;
  }

  _forfeit() {
    if (!this.engine || this.engine.outcome) return;
    // Send forfeit 3 times with 2s gap — overcome packet loss
    const send = (n) => {
      if (this.opponentNode && this.lobby) {
        this.lobby.forfeit(this._getGameId(), this.opponentNode);
      }
      if (n > 1) setTimeout(() => send(n - 1), 2000);
    };
    send(3);
    this.engine.forfeit(this.localIsP1 ? 'p1' : 'p2');
    this._transition(STATE.GAME_OVER, { won: false, draw: false, winner: this.opponentNick || 'Opponent' });
  }

  _getGameId() {
    return this.gameSeed ? this.gameSeed.toString(16).slice(0, 4).toUpperCase() : '0000';
  }

  // ==========================================================
  // Game flow helpers
  // ==========================================================
  _maybeEndTurn() {
    if (!this.engine) return;
    if (this.engine.isAnimating()) return;
    if (this.engine.outcome) return;

    if (this._postImpactTimer) { clearTimeout(this._postImpactTimer); this._postImpactTimer = null; }

    // After animation finishes, wait for explosion then switch turns
    this._postImpactTimer = setTimeout(() => {
      this._postImpactTimer = null;
      if (!this.engine || this.engine.outcome) return;

      this.engine.advanceRound();
      this._updateHUD();

      if (this.state === STATE.ANIMATING) {
        // My shot done → opponent's turn
        this._transition(STATE.OPPONENT_TURN);
        // Also check if my shot killed opponent, send result
        if (this.engine.outcome && this.opponentNode) {
          this._sendResult();
        }
      } else if (this.state === STATE.WATCHING) {
        // Opponent's shot done → my turn
        this._transition(STATE.MY_TURN);
        if (this.engine.outcome && this.opponentNode) {
          this._sendResult();
        }
      }
    }, 1200);
  }

  _sendResult() {
    if (!this.opponentNode || !this.lobby || !this.engine) return;
    const packet = resultPacket(this._getGameId(), this.nodeId, this.nickname,
                                this.engine.outcome, this.engine.round);
    this.transport.sendDirect(this.opponentNode, packet);
  }

  // ==========================================================
  // Cleanup
  // ==========================================================
  _cleanupGame() {
    this._clearTurnResend();
    this.openGameId = null;
    this.opponentNode = null;
    this.opponentNick = null;
    if (this._offerHeartbeatTimer) { clearInterval(this._offerHeartbeatTimer); this._offerHeartbeatTimer = null; }
    if (this._postImpactTimer) { clearTimeout(this._postImpactTimer); this._postImpactTimer = null; }
    if (this._startGameTimer) { clearTimeout(this._startGameTimer); this._startGameTimer = null; }
  }

  _resetToLobby() {
    if (this.openGameId) {
      this.lobby?.cancel(this.openGameId);
      this.openGameId = null;
    }
    this._cleanupGame();
    this.engine?.reset();
    this.engine = null;
    this.gameSeed = 0;
    this.seenPackets = new Set();
    this.lastPacketFromOpponent = 0;
    this.connectionLost = false;
    this.localIsP1 = true;
    this._transition(STATE.LOBBY);
  }

  _cancelOpenGame() {
    if (this.openGameId) {
      this.lobby?.cancel(this.openGameId);
      this.openGameId = null;
    }
    if (this._offerHeartbeatTimer) { clearInterval(this._offerHeartbeatTimer); this._offerHeartbeatTimer = null; }
  }

  // ==========================================================
  // Game Loop
  // ==========================================================
  start() {
    this._lastTime = performance.now();
    this._rafId = requestAnimationFrame(t => this._loop(t));
  }

  _loop(timestamp) {
    const dt = Math.min((timestamp - this._lastTime) / 1000, 0.1);
    this._lastTime = timestamp;
    this._update(dt);
    this._render();
    this._rafId = requestAnimationFrame(t => this._loop(t));
  }

  _update(dt) {
    // Simulate only when animating or watching
    if (this.state === STATE.ANIMATING || this.state === STATE.WATCHING) {
      this.engine?.update(dt);

      // Detect end of animation
      if (!this.engine?.isAnimating()) {
        if (!this._postImpactTimer && !this.engine?.outcome) {
          // Animation just finished — schedule turn end
          this._postImpactTimer = setTimeout(() => {
            this._postImpactTimer = null;
            if (!this.engine || this.engine.outcome) return;

            // Check engine outcome (might have been set by impact)
            if (this.engine.outcome) {
              this._sendResult();
              const won = (this.engine.outcome === 'p1' && this.localIsP1) ||
                          (this.engine.outcome === 'p2' && !this.localIsP1) ||
                          this.engine.outcome === 'draw';
              this._transition(STATE.GAME_OVER, {
                won: won && this.engine.outcome !== 'draw',
                draw: this.engine.outcome === 'draw',
                winner: this.engine.outcome === 'draw' ? 'Draw' :
                  (this.engine.outcome === 'p1' ?
                    (this.localIsP1 ? this.nickname : this.opponentNick) :
                    (this.localIsP1 ? this.opponentNick : this.nickname)),
              });
              return;
            }

            this.engine.advanceRound();
            this._updateHUD();

            if (this.state === STATE.ANIMATING) {
              this._transition(STATE.OPPONENT_TURN);
            } else if (this.state === STATE.WATCHING) {
              this._transition(STATE.MY_TURN);
            }
          }, 1200);
        }
      }
    }

    // Offer heartbeat is handled by _startOfferHeartbeat() timer — no duplicate here.

    this._checkConnection();
  }

  _render() {
    this.renderer.render(this.engine?.getState());

    // Aim line during MY_TURN
    if (this.state === STATE.MY_TURN && this.engine) {
      const playerIdx = this.localIsP1 ? 0 : 1;
      const aim = this.engine.getAimData(playerIdx);
      if (aim) {
        const angle = parseInt(document.getElementById('angle-slider').value);
        const power = parseInt(document.getElementById('power-slider').value);
        this.renderer.drawAimLine(aim.x, aim.y, angle, power);
      }
    }
  }

  // ==========================================================
  // HUD
  // ==========================================================
  _updateHUD() {
    if (!this.engine) return;
    const hp1 = this.engine.p1Hp;
    const hp2 = this.engine.p2Hp;
    const wr = this.engine.round;

    document.getElementById('round-num').textContent = wr;
    document.getElementById('hud-p1-hp-text').textContent = Math.max(0, Math.round(hp1));
    document.getElementById('hud-p2-hp-text').textContent = Math.max(0, Math.round(hp2));
    document.getElementById('hud-p1-hp').style.width = Math.max(0, hp1) + '%';
    document.getElementById('hud-p2-hp').style.width = Math.max(0, hp2) + '%';

    for (const [el, hp] of [['hud-p1-hp', hp1], ['hud-p2-hp', hp2]]) {
      const d = document.getElementById(el);
      d.classList.remove('hp-green', 'hp-yellow', 'hp-red');
      if (hp > 60) d.classList.add('hp-green');
      else if (hp > 30) d.classList.add('hp-yellow');
      else d.classList.add('hp-red');
    }

    this._updateWindDisplay();
    this._updateConnectionDot();
  }

  _updateWindDisplay() {
    const w = this.engine?.wind ?? 0;
    document.getElementById('wind-value').textContent = Math.abs(w);
    document.getElementById('wind-arrow').textContent = w < 0 ? '←' : w > 0 ? '→' : '·';
  }

  _updateConnectionDot() {
    const dot = document.getElementById('connection-dot');
    const timer = document.getElementById('last-activity');
    if (!dot) return;
    dot.classList.remove('conn-ok', 'conn-warn', 'conn-lost');
    if (timer) { timer.classList.remove('stale', 'lost'); timer.textContent = '0s'; }

    if (!this.opponentNode) {
      dot.classList.add('conn-ok'); dot.title = 'No game active'; return;
    }

    const since = (performance.now() / 1000) - this.lastPacketFromOpponent;
    if (this.lastPacketFromOpponent === 0) {
      dot.classList.add('conn-warn'); dot.title = 'Waiting for opponent...';
    } else if (since < 30) {
      dot.classList.add('conn-ok'); dot.title = 'Connected';
      if (timer) timer.textContent = Math.round(since) + 's';
    } else if (since < 90) {
      dot.classList.add('conn-warn'); dot.title = 'Slow connection...';
      if (timer) { timer.textContent = Math.round(since) + 's'; timer.classList.add('stale'); }
    } else {
      dot.classList.add('conn-lost'); dot.title = 'Opponent disconnected!';
      if (timer) { timer.textContent = Math.round(since) + 's'; timer.classList.add('lost'); }
    }
  }

  _checkConnection() {
    const inGame = GAME_STATES.includes(this.state);

    // Also track connection while waiting for accept in lobby
    if (!inGame && !this._waitingAccept) return;
    if (!this.opponentNode) return;

    // Update the activity timer every frame (even in lobby waiting state)
    this._updateConnectionDot();

    if (!inGame) return; // rest is game-only
    if (this.lastPacketFromOpponent === 0) return;

    const since = (performance.now() / 1000) - this.lastPacketFromOpponent;
    if (since > 90 && this.connectionLost && this.engine && !this.engine.outcome) {
      console.log('[Conn] Opponent disconnected, ending game');
      this.engine.forfeit(this.localIsP1 ? 'p2' : 'p1');
      this._transition(STATE.GAME_OVER, { won: true, draw: false, winner: this.nickname, forfeit: true });
    }
    if (since > 60 && !this.connectionLost) {
      this.connectionLost = true;
      this._updateConnectionDot();
    }
  }

  // ==========================================================
  // UI Bindings
  // ==========================================================
  _bindUI() {
    // Connection
    document.getElementById('btn-mock').addEventListener('click', () => {
      this._initMockTransport();
      this.start();
    });
    document.getElementById('btn-ble').addEventListener('click', () => {
      this._connectMeshtastic('ble');
    });
    document.getElementById('btn-serial').addEventListener('click', () => {
      this._connectMeshtastic('serial');
    });
    document.getElementById('btn-wifi').addEventListener('click', () => {
      const url = prompt('Bridge HTTP URL:', 'http://localhost:8081');
      if (url) this._connectMeshtastic('http', { httpUrl: url });
    });
    document.getElementById('btn-http').addEventListener('click', () => {
      const ip = prompt('Enter Meshtastic node IP:', '192.168.1.');
      if (ip) this._connectMeshtastic('http', { httpUrl: `http://${ip}` });
    });

    // Lobby
    document.getElementById('btn-open').addEventListener('click', () => this._openGame());
    document.getElementById('btn-refresh').addEventListener('click', () => this._refreshGameList());
    document.getElementById('btn-test-tx').addEventListener('click', () => this._testTx());
    document.getElementById('btn-cancel-waiting').addEventListener('click', () => {
      this._cancelOpenGame();
      this._transition(STATE.LOBBY);
    });
    document.getElementById('btn-back-lobby').addEventListener('click', () => this._resetToLobby());

    // Controls
    document.getElementById('angle-slider').addEventListener('input', e => {
      document.getElementById('angle-value').textContent = e.target.value;
    });
    document.getElementById('power-slider').addEventListener('input', e => {
      document.getElementById('power-value').textContent = e.target.value;
    });
    document.getElementById('btn-fire').addEventListener('click', () => this.fire());
    document.getElementById('btn-forfeit').addEventListener('click', () => {
      if (confirm('Surrender? Your opponent will win.')) this._forfeit();
    });

    // Keyboard
    document.addEventListener('keydown', (e) => {
      if (this.state !== STATE.MY_TURN) return;
      const as = document.getElementById('angle-slider');
      const ps = document.getElementById('power-slider');
      switch (e.key) {
        case 'ArrowLeft':  as.value = Math.max(0, parseInt(as.value) - 1); break;
        case 'ArrowRight': as.value = Math.min(180, parseInt(as.value) + 1); break;
        case 'ArrowUp':    ps.value = Math.min(100, parseInt(ps.value) + 1); break;
        case 'ArrowDown':  ps.value = Math.max(0, parseInt(ps.value) - 1); break;
        case ' ': case 'Enter': e.preventDefault(); this.fire(); break;
      }
      document.getElementById('angle-value').textContent = as.value;
      document.getElementById('power-value').textContent = ps.value;
    });
  }
}

// ============================================================
// Boot
// ============================================================
const app = new MeshGame();
