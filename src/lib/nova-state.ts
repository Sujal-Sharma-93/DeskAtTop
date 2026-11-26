export type NovaVisualState = 'collapsed' | 'expanded' | 'closing';

export interface NovaTimers {
  set(tick: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

export interface NovaMachineOptions {
  timers: NovaTimers;
  collapseDelay: () => number;
  closeAnimationMs: () => number;
  hoverEnabled?: () => boolean;
  onChange: (state: NovaVisualState) => void;
}

export class NovaMachine {
  private stateValue: NovaVisualState = 'collapsed';
  private collapseTimer: unknown;
  private finishTimer: unknown;
  private hasCollapseTimer = false;
  private hasFinishTimer = false;
  private hovering = false;
  private interacting = false;
  private focusWithin = false;
  private readonly options: NovaMachineOptions;

  constructor(options: NovaMachineOptions) {
    this.options = options;
  }

  get state(): NovaVisualState {
    return this.stateValue;
  }

  get isHovering(): boolean {
    return this.hovering;
  }

  get hasPendingCollapse(): boolean {
    return this.hasCollapseTimer;
  }

  enter(): void {
    this.hovering = true;
    this.clearCollapse();
    this.clearFinish();
    if (this.stateValue === 'closing' || (this.options.hoverEnabled?.() ?? true)) {
      this.expand();
    }
  }

  leave(): void {
    this.hovering = false;
    this.clearCollapse();
    if (this.stateValue === 'expanded') this.scheduleCollapse();
  }

  interactStart(): void {
    this.interacting = true;
    this.clearCollapse();
  }

  interactEnd(): void {
    this.interacting = false;
    this.scheduleCollapseIfIdle();
  }

  focusStart(): void {
    this.focusWithin = true;
    this.clearCollapse();
  }

  focusEnd(): void {
    this.focusWithin = false;
    this.scheduleCollapseIfIdle();
  }

  open(): void {
    this.clearCollapse();
    this.clearFinish();
    this.expand();
  }

  cancelTimers(): void {
    this.clearCollapse();
    this.clearFinish();
  }

  private expand(): void {
    if (this.stateValue === 'expanded') return;
    this.stateValue = 'expanded';
    this.options.onChange(this.stateValue);
  }

  private scheduleCollapseIfIdle(): void {
    if (this.stateValue !== 'expanded' || this.interacting || this.focusWithin || this.hovering) return;
    this.scheduleCollapse();
  }

  private scheduleCollapse(): void {
    this.clearCollapse();
    if (this.stateValue !== 'expanded' || this.interacting || this.focusWithin || this.hovering) return;
    this.hasCollapseTimer = true;
    this.collapseTimer = this.options.timers.set(
      () => this.collapseNow(),
      Math.max(0, this.options.collapseDelay()),
    );
  }

  private collapseNow(): void {
    this.hasCollapseTimer = false;
    this.collapseTimer = undefined;
    if (this.stateValue !== 'expanded') return;
    if (this.interacting || this.focusWithin || this.hovering) {
      this.scheduleCollapseIfIdle();
      return;
    }
    this.clearFinish();
    this.stateValue = 'closing';
    this.options.onChange(this.stateValue);
    this.hasFinishTimer = true;
    this.finishTimer = this.options.timers.set(
      () => this.finishClose(),
      Math.max(0, this.options.closeAnimationMs()),
    );
  }

  private finishClose(): void {
    this.hasFinishTimer = false;
    this.finishTimer = undefined;
    if (this.stateValue !== 'closing') return;
    this.stateValue = 'collapsed';
    this.options.onChange(this.stateValue);
  }

  private clearCollapse(): void {
    if (!this.hasCollapseTimer) return;
    this.options.timers.clear(this.collapseTimer);
    this.collapseTimer = undefined;
    this.hasCollapseTimer = false;
  }

  private clearFinish(): void {
    if (!this.hasFinishTimer) return;
    this.options.timers.clear(this.finishTimer);
    this.finishTimer = undefined;
    this.hasFinishTimer = false;
  }
}
