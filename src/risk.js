// Outer risk gate for GridBot. It observes market/account conditions and
// decides whether new exposure may be opened. It does not calculate grid
// levels, replace fills, or alter reduce-only orders.

export const DEFAULT_RISK_GUARD = Object.freeze({
  enabled: true,
  maxPositionRatio: 0.35,
  maxPositionBase: null,
  moveWindowMs: 300_000,
  softMovePct: 0.0075,
  shockMovePct: 0.02,
  softConfirmations: 3,
  stableResumeMs: 60_000,
  liquidationWarnPct: 0.08,
  liquidationEmergencyPct: 0.04,
  drawdownWarnPct: 0.05,
  drawdownEmergencyPct: 0.10,
});

export function normalizeRiskGuard(input = {}, { gridCount = 20, sizeBase = 1 } = {}) {
  const source = input && typeof input === 'object' ? input : {};
  const count = positive(source.gridCount, gridCount);
  const size = positive(source.sizeBase, sizeBase);
  const maxPositionRatio = bounded(source.maxPositionRatio, DEFAULT_RISK_GUARD.maxPositionRatio, 0.01, 1);
  const explicitMax = positiveOrNull(source.maxPositionBase);
  const derivedMax = Math.max(size * 2, count * size * maxPositionRatio);
  return {
    enabled: source.enabled !== false,
    maxPositionRatio,
    maxPositionBase: explicitMax ?? derivedMax,
    moveWindowMs: Math.max(1_000, integer(source.moveWindowMs, DEFAULT_RISK_GUARD.moveWindowMs)),
    softMovePct: bounded(source.softMovePct, DEFAULT_RISK_GUARD.softMovePct, 0.0001, 1),
    shockMovePct: bounded(source.shockMovePct, DEFAULT_RISK_GUARD.shockMovePct, 0.0001, 1),
    softConfirmations: Math.max(1, integer(source.softConfirmations, DEFAULT_RISK_GUARD.softConfirmations)),
    stableResumeMs: Math.max(0, integer(source.stableResumeMs, DEFAULT_RISK_GUARD.stableResumeMs)),
    liquidationWarnPct: bounded(source.liquidationWarnPct, DEFAULT_RISK_GUARD.liquidationWarnPct, 0.001, 1),
    liquidationEmergencyPct: bounded(source.liquidationEmergencyPct, DEFAULT_RISK_GUARD.liquidationEmergencyPct, 0.0005, 1),
    drawdownWarnPct: bounded(source.drawdownWarnPct, DEFAULT_RISK_GUARD.drawdownWarnPct, 0.001, 1),
    drawdownEmergencyPct: bounded(source.drawdownEmergencyPct, DEFAULT_RISK_GUARD.drawdownEmergencyPct, 0.001, 1),
  };
}

export class RiskGuard {
  constructor(input = {}, dimensions = {}) {
    this.config = normalizeRiskGuard(input, dimensions);
    this.reset();
  }

  reset({ keepHistory = false } = {}) {
    if (!keepHistory) this.priceHistory = [];
    this._lastPrice = this.priceHistory.at(-1)?.price ?? null;
    this._lastTimestamp = this.priceHistory.at(-1)?.timestamp ?? null;
    this._direction = 0;
    this._directionStreak = 0;
    this._level = 'normal';
    this._blockedSides = [];
    this._reason = 'normal';
    this._reasons = [];
    this._softSince = null;
    this._stableSince = null;
    this._latched = false;
    this._updatedAt = Date.now();
    this._lastDecision = this._decision({});
  }

  /** Add one market sample and evaluate the current account/risk context. */
  observe(context = {}) {
    const price = finite(context.price) && context.price > 0 ? Number(context.price) : null;
    let timestamp = finite(context.timestamp) ? Number(context.timestamp) : Date.now();
    if (this._lastTimestamp != null && timestamp < this._lastTimestamp) timestamp = this._lastTimestamp;
    const gapMovement = price != null && this._lastPrice > 0 && this._lastTimestamp != null
      && timestamp - this._lastTimestamp > this.config.moveWindowMs
      ? { pct: price / this._lastPrice - 1, from: this._lastTimestamp, to: timestamp, gap: true }
      : null;
    if (price != null) {
      const previous = this._lastPrice;
      if (previous != null && previous > 0) {
        const direction = Math.sign(price - previous);
        if (direction === 0) {
          this._direction = 0;
          this._directionStreak = 0;
        } else if (direction === this._direction) {
          this._directionStreak++;
        } else {
          this._direction = direction;
          this._directionStreak = 1;
        }
      }
      this._lastPrice = price;
      this._lastTimestamp = timestamp;
      this.priceHistory.push({ price, timestamp });
      const keepFrom = timestamp - Math.max(this.config.moveWindowMs * 2, 60_000);
      this.priceHistory = this.priceHistory.filter((sample) => sample.timestamp >= keepFrom);
    }
    return this.evaluate({ ...context, price: price ?? context.price, timestamp, gapMovement });
  }

  /** Evaluate without adding a new price sample (used after fills/account updates). */
  evaluate(context = {}) {
    const price = finite(context.price) && Number(context.price) > 0
      ? Number(context.price) : this._lastPrice;
    const requestedTimestamp = finite(context.timestamp) ? Number(context.timestamp) : Date.now();
    const timestamp = this._lastTimestamp == null
      ? requestedTimestamp : Math.max(this._lastTimestamp, requestedTimestamp);
    const position = context.position || null;
    const positionSize = finite(context.positionSize)
      ? Number(context.positionSize) : Number(position?.sizeBase || 0);
    const movement = price != null ? (this._movement(price, timestamp) || context.gapMovement || null) : null;
    const blocked = new Set();
    const softReasons = [];
    const emergencyReasons = [];

    if (!this.config.enabled) return this._setNormal(timestamp, movement, positionSize);

    if (movement && Math.abs(movement.pct) >= this.config.shockMovePct) {
      emergencyReasons.push('shock-move');
      blockBoth(blocked);
    }

    const liquidationDistance = liquidationDistancePct(price, position);
    if (liquidationDistance != null) {
      if (liquidationDistance <= this.config.liquidationEmergencyPct) {
        emergencyReasons.push('liquidation-distance');
        addExposureSide(blocked, positionSize);
      } else if (liquidationDistance <= this.config.liquidationWarnPct) {
        softReasons.push('liquidation-distance');
        addExposureSide(blocked, positionSize);
      }
    }

    const drawdown = drawdownPct(context.equity, context.startBalance);
    if (drawdown != null) {
      if (drawdown <= -this.config.drawdownEmergencyPct) {
        emergencyReasons.push('drawdown');
        addExposureSide(blocked, positionSize);
      } else if (drawdown <= -this.config.drawdownWarnPct) {
        softReasons.push('drawdown');
        addExposureSide(blocked, positionSize);
      }
    }

    if (Math.abs(positionSize) >= this.config.maxPositionBase - 1e-12) {
      softReasons.push('max-position');
      addExposureSide(blocked, positionSize);
    }

    if (movement && Math.abs(movement.pct) >= this.config.softMovePct
        && this._directionStreak >= this.config.softConfirmations) {
      softReasons.push('one-sided-move');
      blocked.add(movement.pct > 0 ? 'sell' : 'buy');
    }

    if (emergencyReasons.length) {
      this._latched = true;
      this._level = 'emergency';
      this._blockedSides = ['buy', 'sell'];
      this._reason = emergencyReasons[0];
      this._reasons = unique(emergencyReasons.concat(softReasons));
      this._softSince ??= timestamp;
      this._stableSince = null;
      return this._setDecision({
        timestamp, movement, positionSize, liquidationDistance, drawdown,
      });
    }

    if (this._latched || this._level === 'emergency') {
      return this._setDecision({ timestamp, movement, positionSize, liquidationDistance, drawdown });
    }

    if (softReasons.length) {
      this._level = 'soft';
      this._blockedSides = [...blocked];
      this._reason = softReasons[0];
      this._reasons = unique(softReasons);
      this._softSince ??= timestamp;
      this._stableSince = null;
      return this._setDecision({ timestamp, movement, positionSize, liquidationDistance, drawdown });
    }

    if (this._level === 'soft') {
      this._stableSince ??= timestamp;
      if (timestamp - this._stableSince < this.config.stableResumeMs) {
        this._reason = 'stabilizing';
        this._reasons = ['stabilizing'];
        return this._setDecision({ timestamp, movement, positionSize, liquidationDistance, drawdown });
      }
    }

    return this._setNormal(timestamp, movement, positionSize, liquidationDistance, drawdown);
  }

  canPlace({ side, opening = true, reduceOnly = false, recovery = false, sizeBase = 0, positionSize = 0 } = {}) {
    if (!this.config.enabled || !opening || reduceOnly || recovery) return { allowed: true, reason: 'closing-or-disabled' };
    if (this._latched || this._level === 'emergency') return { allowed: false, reason: 'emergency' };
    if (this._blockedSides.includes('buy') && this._blockedSides.includes('sell')) {
      return { allowed: false, reason: this._reason };
    }
    if (this._blockedSides.includes(side)) return { allowed: false, reason: this._reason };
    const size = Math.max(0, Number(sizeBase) || 0);
    const current = Number(positionSize) || 0;
    const projected = current + (side === 'sell' ? -size : size);
    if (Math.abs(projected) > this.config.maxPositionBase + 1e-12) {
      return { allowed: false, reason: 'max-position' };
    }
    return { allowed: true, reason: 'normal' };
  }

  state() {
    return { ...this._lastDecision, config: { ...this.config } };
  }

  snapshot() {
    return {
      priceHistory: this.priceHistory.slice(-240),
      lastPrice: this._lastPrice,
      lastTimestamp: this._lastTimestamp,
      direction: this._direction,
      directionStreak: this._directionStreak,
      level: this._level,
      blockedSides: this._blockedSides,
      reason: this._reason,
      reasons: this._reasons,
      softSince: this._softSince,
      stableSince: this._stableSince,
      latched: this._latched,
      updatedAt: this._updatedAt,
      decision: this._lastDecision,
    };
  }

  restore(snapshot = {}) {
    if (!snapshot || typeof snapshot !== 'object') return;
    this.priceHistory = Array.isArray(snapshot.priceHistory)
      ? snapshot.priceHistory.filter((sample) => finite(sample?.price) && finite(sample?.timestamp)).slice(-240)
      : [];
    this._lastPrice = finite(snapshot.lastPrice) ? Number(snapshot.lastPrice) : this.priceHistory.at(-1)?.price ?? null;
    this._lastTimestamp = finite(snapshot.lastTimestamp) ? Number(snapshot.lastTimestamp) : this.priceHistory.at(-1)?.timestamp ?? null;
    this._direction = Number(snapshot.direction) || 0;
    this._directionStreak = Math.max(0, Number(snapshot.directionStreak) || 0);
    this._level = ['normal', 'soft', 'emergency'].includes(snapshot.level) ? snapshot.level : 'normal';
    this._blockedSides = Array.isArray(snapshot.blockedSides) ? snapshot.blockedSides.filter((s) => s === 'buy' || s === 'sell') : [];
    this._reason = String(snapshot.reason || 'normal');
    this._reasons = Array.isArray(snapshot.reasons) ? snapshot.reasons.map(String) : [];
    this._softSince = finite(snapshot.softSince) ? Number(snapshot.softSince) : null;
    this._stableSince = finite(snapshot.stableSince) ? Number(snapshot.stableSince) : null;
    this._latched = snapshot.latched === true || this._level === 'emergency';
    this._updatedAt = finite(snapshot.updatedAt) ? Number(snapshot.updatedAt) : Date.now();
    this._lastDecision = snapshot.decision && typeof snapshot.decision === 'object'
      ? { ...snapshot.decision }
      : this._decision({});
  }

  _movement(price, timestamp) {
    if (!(price > 0) || !this.priceHistory.length) return null;
    const cutoff = timestamp - this.config.moveWindowMs;
    let base = null;
    for (const sample of this.priceHistory) {
      if (sample.timestamp <= cutoff) base = sample;
    }
    if (!base || !(base.price > 0)) return null;
    return { pct: price / base.price - 1, from: base.timestamp, to: timestamp };
  }

  _setNormal(timestamp, movement, positionSize, liquidationDistance = null, drawdown = null) {
    this._level = 'normal';
    this._blockedSides = [];
    this._reason = 'normal';
    this._reasons = [];
    this._softSince = null;
    this._stableSince = null;
    return this._setDecision({ timestamp, movement, positionSize, liquidationDistance, drawdown });
  }

  _setDecision({ timestamp, movement = null, positionSize = 0, liquidationDistance = null, drawdown = null } = {}) {
    this._updatedAt = timestamp ?? Date.now();
    this._lastDecision = this._decision({ timestamp, movement, positionSize, liquidationDistance, drawdown });
    return this._lastDecision;
  }

  _decision({ timestamp, movement = null, positionSize = 0, liquidationDistance = null, drawdown = null } = {}) {
    const blockedSides = [...this._blockedSides];
    return {
      level: this._level,
      blockedSide: blockedSides.length === 2 ? 'both' : blockedSides[0] || null,
      blockedSides,
      reason: this._reason,
      reasons: this._reasons.slice(),
      movePct: movement ? movement.pct * 100 : null,
      direction: this._direction,
      directionStreak: this._directionStreak,
      positionSize: Number(positionSize) || 0,
      positionRatio: this.config.maxPositionBase > 0
        ? Math.abs(Number(positionSize) || 0) / this.config.maxPositionBase : 0,
      liquidationDistancePct: liquidationDistance == null ? null : liquidationDistance * 100,
      drawdownPct: drawdown == null ? null : drawdown * 100,
      stableSince: this._stableSince,
      softSince: this._softSince,
      latched: this._latched,
      updatedAt: timestamp ?? this._updatedAt,
    };
  }
}

function addExposureSide(blocked, positionSize) {
  if (Number(positionSize) > 0) blocked.add('buy');
  else if (Number(positionSize) < 0) blocked.add('sell');
  else blockBoth(blocked);
}

function blockBoth(blocked) {
  blocked.add('buy');
  blocked.add('sell');
}

function liquidationDistancePct(price, position) {
  const px = Number(price);
  const liq = Number(position?.liquidationPrice);
  const size = Number(position?.sizeBase) || 0;
  if (!(px > 0) || !(liq > 0) || !size) return null;
  return size > 0 ? (px - liq) / px : (liq - px) / px;
}

function drawdownPct(equity, startBalance) {
  const eq = Number(equity), start = Number(startBalance);
  if (!(start > 0) || !Number.isFinite(eq)) return null;
  return eq / start - 1;
}

function unique(values) { return [...new Set(values)]; }
function finite(value) { return value != null && Number.isFinite(Number(value)); }
function positive(value, fallback) { return Number(value) > 0 ? Number(value) : Number(fallback); }
function positiveOrNull(value) { return Number(value) > 0 ? Number(value) : null; }
function integer(value, fallback) { return Number.isFinite(Number(value)) ? Math.round(Number(value)) : fallback; }
function bounded(value, fallback, min, max) { return Math.min(max, Math.max(min, positive(value, fallback))); }
