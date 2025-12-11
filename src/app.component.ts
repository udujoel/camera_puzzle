import { Component, signal, ChangeDetectionStrategy, ViewChild, ElementRef, OnDestroy, WritableSignal, computed, AfterViewInit } from '@angular/core';
import { GoogleGenAI } from '@google/genai';

const PUZZLE_DIMENSION = 600; // Should be easily divisible by grid sizes (3, 4, 5)

declare var confetti: any;

interface AnimationState {
  index1: number;
  index2: number;
  startTime: number;
  duration: number;
}

interface Score {
  score: number;
  moves: number;
  time: number; // ms
  date: number; // timestamp
}

type Leaderboard = {
  '3': Score[];
  '4': Score[];
  '5': Score[];
};

interface TimedChallengeStats {
    puzzlesCleared: number;
    totalMoves: number;
    difficulty: number;
    duration: number; // minutes
}

const LEADERBOARD_KEY = 'camera-puzzle-leaderboard';

@Component({
  selector: 'app-root',
  templateUrl: './app.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AppComponent implements OnDestroy, AfterViewInit {
  @ViewChild('videoElement') videoElement!: ElementRef<HTMLVideoElement>;
  @ViewChild('puzzleCanvas') puzzleCanvas?: ElementRef<HTMLCanvasElement>;

  gameState: WritableSignal<'idle' | 'countdown' | 'playing' | 'won' | 'times-up' | 'stage-cleared' | 'error'> = signal('idle');
  gameMode = signal<'classic' | 'timed' | null>(null);
  cameraError: WritableSignal<string | null> = signal(null);
  gridSize = signal(3);
  tiles: WritableSignal<number[]> = signal([]);
  selectedTileIndex: WritableSignal<number | null> = signal(null);
  focusedTileIndex: WritableSignal<number | null> = signal(null);
  isShuffling = signal(false);
  moveCount = signal(0);
  timeTaken = signal(0);
  showGhostHint = signal(false);
  
  // Start screen UI state
  showCustomGameMenu = signal(false);
  typingState = signal<'pre-typing' | 'typing' | 'done'>('pre-typing');
  displayedInstructionText = signal('');

  // Custom Game settings
  customDifficulty = signal(3);
  customMode = signal<'classic' | 'timed'>('classic');
  customDuration = signal(3);
  
  countdownValue = signal<number | string>(3);
  hintsRemaining = signal(0);
  shakeHintButton = signal(false);
  showHintTooltip = signal(false);
  
  // Victory message state
  victoryMessages = signal<string[]>(['Congratulations, you unscrambled the view!']);
  displayedVictoryMessage = signal('');
  
  undoButtonPressed = signal(false);

  // Leaderboard and Score
  leaderboard = signal<Leaderboard>({ '3': [], '4': [], '5': [] });
  activeLeaderboardTab = signal<3 | 4 | 5>(3);
  currentScore = signal(0);
  displayedScore = signal(0);

  // Timed Challenge
  puzzlesCleared = signal(0);
  challengeTimeRemaining = signal(0); // in ms
  sessionTotalMoves = signal(0);
  finalTimedStats = signal<TimedChallengeStats | null>(null);

  // Undo feature
  private moveHistory: WritableSignal<{ index1: number, index2: number }[]> = signal([]);

  // Glow animation state
  correctTileGlows: WritableSignal<{ [index: number]: number }> = signal({});
  private readonly GLOW_DURATION = 700; // ms

  private stream: MediaStream | null = null;
  private animationFrameId: number | null = null;
  private currentAnimation: AnimationState | null = null;
  private startTime = 0;
  private hintTimer: any = null;
  private hintTooltipTimer: any = null;
  private typingTimeout: any;
  private victoryTypingTimeout: any;
  private countdownTimeouts: any[] = [];
  private challengeTimer: any = null;
  private stageClearedTimeout: any = null;
  private scoreAnimationTimer: any = null;

  // Intro tips animation state
  private tips = [
    "Welcome to the Camera Puzzle!",
    "Unscramble your live camera feed by swapping the tiles.",
    "Try Classic mode for a strategic challenge or Timed for a race against the clock.",
    "The faster you solve, the higher your score."
  ];
  private currentTipIndex = 0;
  private isDeleting = false;

  // Victory message animation state
  private currentVictoryMessageIndex = 0;
  private isVictoryMessageDeleting = false;
  
  private typingSpeed = 50;
  private deletingSpeed = 30;
  
  public readonly PUZZLE_DIMENSION = PUZZLE_DIMENSION;

  formattedTime = computed(() => {
    const totalSeconds = Math.floor(this.timeTaken() / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;

    const parts = [];
    if (minutes > 0) {
      parts.push(`${minutes} minute${minutes > 1 ? 's' : ''}`);
    }
    if (seconds > 0 || minutes === 0) {
        parts.push(`${seconds} second${seconds !== 1 ? 's' : ''}`);
    }
    
    return parts.join(' and ');
  });
  
  formattedChallengeTime = computed(() => {
      const totalSeconds = Math.max(0, Math.ceil(this.challengeTimeRemaining() / 1000));
      const minutes = Math.floor(totalSeconds / 60);
      const seconds = totalSeconds % 60;
      return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  });

  averageTimePerPuzzle = computed(() => {
    const stats = this.finalTimedStats();
    if (!stats || stats.puzzlesCleared === 0) return "N/A";
    
    const totalSeconds = (stats.duration * 60) / stats.puzzlesCleared;
    return `${totalSeconds.toFixed(1)}s`;
  });

  constructor() {
    this.loadLeaderboard();
  }

  ngAfterViewInit(): void {
    if (this.gameState() === 'idle') {
      this.startTypingAnimation();
    }
  }

  ngOnDestroy(): void {
    this.stopGame();
  }

  private runTypingAnimation(): void {
    const currentTip = this.tips[this.currentTipIndex];
    const displayedText = this.displayedInstructionText();

    if (this.isDeleting) {
      this.displayedInstructionText.update(val => val.slice(0, -1));
      if (displayedText.length > 0) {
        this.typingTimeout = setTimeout(() => this.runTypingAnimation(), this.deletingSpeed);
      } else {
        this.isDeleting = false;
        this.currentTipIndex = (this.currentTipIndex + 1) % this.tips.length;
        this.typingTimeout = setTimeout(() => this.runTypingAnimation(), 500);
      }
    } else {
      if (displayedText.length < currentTip.length) {
        this.displayedInstructionText.update(val => currentTip.slice(0, val.length + 1));
        this.typingTimeout = setTimeout(() => this.runTypingAnimation(), this.typingSpeed);
      } else {
        this.isDeleting = true;
        this.typingTimeout = setTimeout(() => this.runTypingAnimation(), 3000);
      }
    }
  }
  
  async startQuickPlay(): Promise<void> {
    this.gameMode.set('classic');
    await this.initiateGame(3);
  }

  async startCustomGame(): Promise<void> {
    const mode = this.customMode();
    const difficulty = this.customDifficulty();
    this.gameMode.set(mode);

    if (mode === 'timed') {
      this.puzzlesCleared.set(0);
      this.sessionTotalMoves.set(0);
      this.challengeTimeRemaining.set(this.customDuration() * 60 * 1000);
    }
    
    await this.initiateGame(difficulty);
  }

  private async initiateGame(size: number): Promise<void> {
    this.gridSize.set(size);
    this.gameState.set('playing'); 
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ video: { width: PUZZLE_DIMENSION, height: PUZZLE_DIMENSION } });
      const video = this.videoElement.nativeElement;
      video.srcObject = this.stream;
      video.onplaying = () => {
        const canvas = this.puzzleCanvas?.nativeElement;
        if (canvas) {
          canvas.width = PUZZLE_DIMENSION;
          canvas.height = PUZZLE_DIMENSION;
        }
        if (this.animationFrameId === null) {
          this.gameLoop();
        }
        this.startCountdown();
      };
    } catch (err) {
      this.handleCameraError(err);
    }
  }

  private startCountdown(): void {
      this.gameState.set('countdown');
      this.countdownValue.set(3);
      this.clearCountdownTimeouts();

      this.countdownTimeouts.push(setTimeout(() => this.countdownValue.set(2), 1000));
      this.countdownTimeouts.push(setTimeout(() => this.countdownValue.set(1), 2000));
      this.countdownTimeouts.push(setTimeout(() => this.countdownValue.set('Go!'), 3000));
      this.countdownTimeouts.push(setTimeout(() => {
        this.gameState.set('playing');
        this.initializePuzzle();
        if (this.gameMode() === 'timed') {
            this.runChallengeTimer();
        }
      }, 4000));
  }
  
  private runChallengeTimer(): void {
    if (this.challengeTimer) clearInterval(this.challengeTimer);
    this.challengeTimer = setInterval(() => {
        this.challengeTimeRemaining.update(t => t - 1000);
        if (this.challengeTimeRemaining() <= 0) {
            this.endTimedChallenge();
        }
    }, 1000);
  }

  private endTimedChallenge(): void {
      this.stopGame();
      this.finalTimedStats.set({
          puzzlesCleared: this.puzzlesCleared(),
          totalMoves: this.sessionTotalMoves(),
          difficulty: this.gridSize(),
          duration: this.customDuration()
      });
      this.gameState.set('times-up');
      this.generateTimedChallengeSummary();
  }

  private initializePuzzle(): void {
    const gridSize = this.gridSize();
    const initialTiles = Array.from({ length: gridSize * gridSize }, (_, i) => i);
    this.tiles.set(initialTiles);

    if (gridSize === 3) this.hintsRemaining.set(5);
    else if (gridSize === 4) this.hintsRemaining.set(4);
    else this.hintsRemaining.set(3);

    this.moveCount.set(0);
    if (this.gameMode() === 'classic') {
        this.timeTaken.set(0);
        this.startTime = performance.now();
    }
    this.moveHistory.set([]);
    this.focusedTileIndex.set(0);
    this.shuffleTiles();
  }
  
  restartPuzzle(): void {
      if (this.gameState() !== 'playing') return;
      this.initializePuzzle();
  }

  peekGhostHint(): void {
    if (this.hintsRemaining() > 0) {
        if (this.hintTimer) clearTimeout(this.hintTimer);
        this.showGhostHint.set(true);
        this.hintsRemaining.update(h => h - 1);
        this.hintTimer = setTimeout(() => this.showGhostHint.set(false), 2500);
    } else {
        this.shakeHintButton.set(true);
        setTimeout(() => this.shakeHintButton.set(false), 500);
        if (this.hintTooltipTimer) clearTimeout(this.hintTooltipTimer);
        this.showHintTooltip.set(true);
        this.hintTooltipTimer = setTimeout(() => this.showHintTooltip.set(false), 2000);
    }
  }

  private handleCameraError(err: unknown): void {
    let errorMessage = 'Could not access the camera. Please ensure permissions are granted.';
    if (err instanceof DOMException) {
      if (err.name === 'NotFoundError' || err.name === 'DevicesNotFoundError') {
        errorMessage = 'No camera found. Please connect a camera and try again.';
      } else if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
        errorMessage = 'Camera access was denied. Please allow camera permissions in your browser settings.';
      } else if (err.name === 'NotReadableError' || err.name === 'TrackStartError') {
        errorMessage = 'Your camera is already in use by another application.';
      }
    }
    this.cameraError.set(errorMessage);
    this.gameState.set('error');
    this.stopGame();
  }

  resetGame(): void {
    this.stopGame();
    this.selectedTileIndex.set(null);
    this.cameraError.set(null);
    this.showCustomGameMenu.set(false);
    this.victoryMessages.set(['Congratulations, you unscrambled the view!']);
    this.gameMode.set(null);
    this.gameState.set('idle');
    this.startTypingAnimation();
  }

  private clearAllTimers(): void {
    if (this.hintTimer) clearTimeout(this.hintTimer);
    if (this.hintTooltipTimer) clearTimeout(this.hintTooltipTimer);
    if (this.typingTimeout) clearTimeout(this.typingTimeout);
    if (this.victoryTypingTimeout) clearTimeout(this.victoryTypingTimeout);
    if (this.challengeTimer) clearInterval(this.challengeTimer);
    if (this.stageClearedTimeout) clearTimeout(this.stageClearedTimeout);
    if (this.scoreAnimationTimer) clearInterval(this.scoreAnimationTimer);
    this.hintTimer = null;
    this.hintTooltipTimer = null;
    this.typingTimeout = null;
    this.victoryTypingTimeout = null;
    this.challengeTimer = null;
    this.stageClearedTimeout = null;
    this.scoreAnimationTimer = null;
    this.clearCountdownTimeouts();
  }

  private clearCountdownTimeouts(): void {
    this.countdownTimeouts.forEach(timeout => clearTimeout(timeout));
    this.countdownTimeouts = [];
  }

  private stopGame(): void {
    if (this.animationFrameId) {
      cancelAnimationFrame(this.animationFrameId);
      this.animationFrameId = null;
    }
    this.clearAllTimers();
    this.showGhostHint.set(false);
    this.stream?.getTracks().forEach(track => track.stop());
    this.stream = null;
    this.tiles.set([]);
    this.isShuffling.set(false);
  }

  private startTypingAnimation(): void {
    this.typingState.set('pre-typing');
    this.displayedInstructionText.set('');
    if (this.typingTimeout) clearTimeout(this.typingTimeout);
    this.typingTimeout = setTimeout(() => {
      this.typingState.set('typing');
      this.isDeleting = false;
      this.currentTipIndex = 0;
      this.runTypingAnimation();
    }, 1500);
  }

  private async shuffleTiles(): Promise<void> {
    this.isShuffling.set(true);
    let currentTiles = [...this.tiles()];
    
    for (let i = currentTiles.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [currentTiles[i], currentTiles[j]] = [currentTiles[j], currentTiles[i]];
    }

    if (this.isSolved(currentTiles)) {
      [currentTiles[0], currentTiles[1]] = [currentTiles[1], currentTiles[0]];
    }
    
    this.tiles.set(currentTiles);

    const gridSize = this.gridSize();
    const tileCount = gridSize * gridSize;
    const shuffleAnimations: { index1: number; index2: number }[] = [];
    for (let i = 0; i < tileCount * 1.5; i++) {
      shuffleAnimations.push({
        index1: Math.floor(Math.random() * tileCount),
        index2: Math.floor(Math.random() * tileCount),
      });
    }

    for (const anim of shuffleAnimations) {
      this.swapTiles(anim.index1, anim.index2, 50);
      await new Promise(resolve => setTimeout(resolve, 60));
    }

    this.isShuffling.set(false);
  }

  private isSolved(tiles: number[]): boolean {
    for (let i = 0; i < tiles.length; i++) {
      if (tiles[i] !== i) return false;
    }
    return true;
  }

  handleCanvasClick(event: MouseEvent): void {
    if (this.gameState() !== 'playing' || this.isShuffling() || this.currentAnimation) return;
    const canvas = this.puzzleCanvas?.nativeElement;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    const gridSize = this.gridSize();
    const tileWidth = canvas.width / gridSize;
    const tileHeight = canvas.height / gridSize;
    const col = Math.floor(x / tileWidth);
    const row = Math.floor(y / tileHeight);
    const clickedIndex = row * gridSize + col;
    this.handleTileInteraction(clickedIndex);
  }

  private handleTileInteraction(interactedIndex: number): void {
    const selectedIdx = this.selectedTileIndex();
    if (selectedIdx === null) {
      this.selectedTileIndex.set(interactedIndex);
    } else {
      if (selectedIdx !== interactedIndex) {
        this.moveHistory.update(history => [...history, { index1: selectedIdx, index2: interactedIndex }]);
        this.moveCount.update(c => c + 1);
        this.swapTiles(selectedIdx, interactedIndex, 200);
      }
      this.selectedTileIndex.set(null);
    }
  }

  handleKeyDown(event: KeyboardEvent): void {
    if (this.gameState() !== 'playing' || this.isShuffling() || this.currentAnimation) return;
    event.preventDefault();
    const gridSize = this.gridSize();
    let currentFocus = this.focusedTileIndex() ?? 0;
    let row = Math.floor(currentFocus / gridSize);
    let col = currentFocus % gridSize;
    switch (event.key) {
      case 'ArrowUp': row = Math.max(0, row - 1); break;
      case 'ArrowDown': row = Math.min(gridSize - 1, row + 1); break;
      case 'ArrowLeft': col = Math.max(0, col - 1); break;
      case 'ArrowRight': col = Math.min(gridSize - 1, col + 1); break;
      case 'Enter': case ' ': this.handleTileInteraction(currentFocus); return;
      default: return;
    }
    this.focusedTileIndex.set(row * gridSize + col);
  }

  handleCanvasMouseMove(event: MouseEvent): void {
    if (this.gameState() !== 'playing') { this.focusedTileIndex.set(null); return; }
    const canvas = this.puzzleCanvas?.nativeElement;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    const gridSize = this.gridSize();
    const tileWidth = canvas.width / gridSize;
    const tileHeight = canvas.height / gridSize;
    const col = Math.floor(x / tileWidth);
    const row = Math.floor(y / tileHeight);
    const hoveredIndex = row * gridSize + col;
    if (hoveredIndex >= 0 && hoveredIndex < gridSize * gridSize) {
      this.focusedTileIndex.set(hoveredIndex);
    } else {
      this.focusedTileIndex.set(null);
    }
  }

  handleCanvasMouseLeave(): void {
    this.focusedTileIndex.set(null);
  }

  private swapTiles(index1: number, index2: number, duration: number): void {
    this.currentAnimation = { index1, index2, startTime: performance.now(), duration };
  }

  undoLastMove(): void {
    if (this.moveHistory().length === 0 || this.currentAnimation) return;
    this.undoButtonPressed.set(true);
    setTimeout(() => this.undoButtonPressed.set(false), 200);
    const newHistory = [...this.moveHistory()];
    const lastMove = newHistory.pop();
    if (!lastMove) return;
    this.moveHistory.set(newHistory);
    this.moveCount.update(c => c > 0 ? c - 1 : 0);
    const tilesCopy = [...this.tiles()];
    const { index1, index2 } = lastMove;
    [tilesCopy[index1], tilesCopy[index2]] = [tilesCopy[index2], tilesCopy[index1]];
    this.tiles.set(tilesCopy);
  }

  private gameLoop = (): void => {
    if (this.gameState() !== 'idle') {
      this.drawScrambledVideo();
    }
    this.animationFrameId = requestAnimationFrame(this.gameLoop);
  };
  
  private triggerGlowAnimation(index: number): void {
    this.correctTileGlows.update(glows => ({
        ...glows,
        [index]: performance.now()
    }));
  }
  
  private drawScrambledVideo(): void {
    const canvas = this.puzzleCanvas?.nativeElement;
    const video = this.videoElement.nativeElement;
    if (!canvas || !video || video.readyState < video.HAVE_METADATA) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const gridSize = this.gridSize();
    const tileWidth = PUZZLE_DIMENSION / gridSize;
    const tileHeight = PUZZLE_DIMENSION / gridSize;
    const videoWidth = video.videoWidth;
    const videoHeight = video.videoHeight;
    const sourceSize = Math.min(videoWidth, videoHeight);
    const sx = (videoWidth - sourceSize) / 2;
    const sy = (videoHeight - sourceSize) / 2;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const currentTiles = this.tiles();
    if (this.gameState() === 'countdown' || this.gameState() === 'won' || this.gameState() === 'times-up' || currentTiles.length === 0) {
      ctx.drawImage(video, sx, sy, sourceSize, sourceSize, 0, 0, canvas.width, canvas.height);
      if (this.showGhostHint()) {
        ctx.globalAlpha = 0.4;
        ctx.drawImage(video, sx, sy, sourceSize, sourceSize, 0, 0, canvas.width, canvas.height);
        ctx.globalAlpha = 1.0;
      }
      return;
    }
    // First pass: draw all tiles
    for (let i = 0; i < currentTiles.length; i++) {
      const tileValue = currentTiles[i];
      const sourceCol = tileValue % gridSize;
      const sourceRow = Math.floor(tileValue / gridSize);
      const destCol = i % gridSize;
      const destRow = Math.floor(i / gridSize);
      let destX = destCol * tileWidth;
      let destY = destRow * tileHeight;
      if (this.currentAnimation) {
          const { index1, index2, startTime, duration } = this.currentAnimation;
          const elapsedTime = performance.now() - startTime;
          let progress = Math.min(elapsedTime / duration, 1);
          const easeInOutQuad = (t: number) => t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t;
          progress = easeInOutQuad(progress);
          const startCol1 = index1 % gridSize;
          const startRow1 = Math.floor(index1 / gridSize);
          const endCol1 = index2 % gridSize;
          const endRow1 = Math.floor(index2 / gridSize);
          if (i === index1) {
            destX = (startCol1 + (endCol1 - startCol1) * progress) * tileWidth;
            destY = (startRow1 + (endRow1 - startRow1) * progress) * tileHeight;
          } else if (i === index2) {
            destX = (endCol1 - (endCol1 - startCol1) * progress) * tileWidth;
            destY = (endRow1 - (endRow1 - startRow1) * progress) * tileHeight;
          }
          if (progress >= 1) {
            const tilesCopy = [...currentTiles];
            const { index1: idx1, index2: idx2 } = this.currentAnimation;
            [tilesCopy[idx1], tilesCopy[idx2]] = [tilesCopy[idx2], tilesCopy[idx1]];
            this.tiles.set(tilesCopy);
            this.currentAnimation = null;
            if (!this.isShuffling()) {
                if (tilesCopy[idx1] === idx1) this.triggerGlowAnimation(idx1);
                if (tilesCopy[idx2] === idx2) this.triggerGlowAnimation(idx2);
                this.checkWinCondition();
            }
          }
      }
      ctx.drawImage(video, sx + sourceCol * (sourceSize / gridSize), sy + sourceRow * (sourceSize / gridSize), sourceSize / gridSize, sourceSize / gridSize, destX, destY, tileWidth, tileHeight);
    }

    // Second pass: draw highlights and glows
    const glows = this.correctTileGlows();
    const now = performance.now();
    for (const indexStr in glows) {
        const index = parseInt(indexStr, 10);
        const destCol = index % gridSize;
        const destRow = Math.floor(index / gridSize);
        const startTime = glows[index];
        const elapsedTime = now - startTime;

        if (elapsedTime < this.GLOW_DURATION) {
            const progress = elapsedTime / this.GLOW_DURATION;
            const perimeter = 2 * (tileWidth + tileHeight);
            const distance = progress * perimeter;
            let glowX = destCol * tileWidth;
            let glowY = destRow * tileHeight;

            if (distance < tileWidth) { // Top edge
                glowX += distance;
            } else if (distance < tileWidth + tileHeight) { // Right edge
                glowX += tileWidth;
                glowY += distance - tileWidth;
            } else if (distance < 2 * tileWidth + tileHeight) { // Bottom edge
                glowX += tileWidth - (distance - (tileWidth + tileHeight));
                glowY += tileHeight;
            } else { // Left edge
                glowY += tileHeight - (distance - (2 * tileWidth + tileHeight));
            }
            
            ctx.beginPath();
            const gradient = ctx.createRadialGradient(glowX, glowY, 2, glowX, glowY, 10);
            gradient.addColorStop(0, 'rgba(74, 222, 128, 0.8)');
            gradient.addColorStop(1, 'rgba(74, 222, 128, 0)');
            ctx.fillStyle = gradient;
            ctx.arc(glowX, glowY, 10, 0, Math.PI * 2);
            ctx.fill();

        } else {
            this.correctTileGlows.update(currentGlows => {
                const newGlows = {...currentGlows};
                delete newGlows[index];
                return newGlows;
            });
        }
    }

    const focusedIdx = this.focusedTileIndex();
    if (focusedIdx !== null && focusedIdx !== this.selectedTileIndex() && !this.currentAnimation && this.gameState() === 'playing') {
      const col = focusedIdx % gridSize;
      const row = Math.floor(focusedIdx / gridSize);
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.7)';
      ctx.lineWidth = 2;
      ctx.strokeRect(col * tileWidth + 1, row * tileHeight + 1, tileWidth - 2, tileHeight - 2);
    }
    const selectedIdx = this.selectedTileIndex();
    if (selectedIdx !== null && !this.currentAnimation && this.gameState() === 'playing') {
      const col = selectedIdx % gridSize;
      const row = Math.floor(selectedIdx / gridSize);
      const scale = 1.05;
      const scaledWidth = tileWidth * scale;
      const scaledHeight = tileHeight * scale;
      const destX = col * tileWidth - (scaledWidth - tileWidth) / 2;
      const destY = row * tileHeight - (scaledHeight - tileHeight) / 2;

      ctx.save();
      ctx.shadowColor = 'rgba(56, 189, 248, 0.7)';
      ctx.shadowBlur = 15;
      const tileValue = currentTiles[selectedIdx];
      const sourceCol = tileValue % gridSize;
      const sourceRow = Math.floor(tileValue / gridSize);
      ctx.drawImage(video, sx + sourceCol * (sourceSize / gridSize), sy + sourceRow * (sourceSize / gridSize), sourceSize / gridSize, sourceSize / gridSize, destX, destY, scaledWidth, scaledHeight);
      ctx.strokeStyle = 'rgba(56, 189, 248, 0.9)';
      ctx.lineWidth = 4;
      ctx.strokeRect(destX + 2, destY + 2, scaledWidth - 4, scaledHeight - 4);
      ctx.restore();
    }
    if (this.showGhostHint()) {
      ctx.globalAlpha = 0.4;
      ctx.drawImage(video, sx, sy, sourceSize, sourceSize, 0, 0, canvas.width, canvas.height);
      ctx.globalAlpha = 1.0;
    }
  }

  private checkWinCondition(): void {
    if (this.isSolved(this.tiles())) {
      if (this.gameMode() === 'classic') {
          const endTime = performance.now();
          const timeTakenMs = endTime - this.startTime;
          this.timeTaken.set(timeTakenMs);
          this.calculateAndSaveScore(timeTakenMs);
          this.gameState.set('won');
          this.generateClassicVictoryMessage();
          this.launchConfetti();
      } else if (this.gameMode() === 'timed') {
          this.puzzlesCleared.update(p => p + 1);
          this.sessionTotalMoves.update(m => m + this.moveCount());
          this.gameState.set('stage-cleared');
          this.stageClearedTimeout = setTimeout(() => {
              this.gameState.set('playing');
              this.initializePuzzle();
          }, 1500);
      }
    }
  }

  private async generateClassicVictoryMessage(): Promise<void> {
    this.victoryMessages.set(['Congratulations!', 'Puzzle Solved!', 'Nicely Done!']);
    this.animateScore();
    this.runCyclingVictoryMessageAnimation();
    try {
        const ai = new GoogleGenAI({ apiKey: process.env.API_KEY as string });
        const prompt = `Act as a fun game commentator. Write 3 short, unique, witty, one-sentence congratulatory messages for a player who solved a ${this.gridSize()}x${this.gridSize()} camera puzzle. Their score was ${this.currentScore()}, they used ${this.moveCount()} moves, and their time was ${this.formattedTime()}. Be creative and enthusiastic! Format the response as a valid JSON array of strings, like ["Message 1", "Message 2", "Message 3"]. Do not include any other text or markdown.`;
        const response = await ai.models.generateContent({ model: 'gemini-2.5-flash', contents: prompt });
        let text = response.text;
        if (text) {
          const cleanedJson = text.trim().replace(/^```json\s*/, '').replace(/```$/, '');
          const messages = JSON.parse(cleanedJson);
          if (Array.isArray(messages) && messages.length > 0) {
            this.victoryMessages.set(messages.map(m => m.trim().replace(/^"|"$/g, '')));
            if (this.victoryTypingTimeout) clearTimeout(this.victoryTypingTimeout);
            this.runCyclingVictoryMessageAnimation();
          }
        }
    } catch (error) {
        console.error("Error generating or parsing classic victory messages:", error);
    }
  }

  private runCyclingVictoryMessageAnimation(): void {
    const currentMessage = this.victoryMessages()[this.currentVictoryMessageIndex];
    const displayedText = this.displayedVictoryMessage();
    if (this.isVictoryMessageDeleting) {
      this.displayedVictoryMessage.update(val => val.slice(0, -1));
      if (displayedText.length > 0) {
        this.victoryTypingTimeout = setTimeout(() => this.runCyclingVictoryMessageAnimation(), this.deletingSpeed);
      } else {
        this.isVictoryMessageDeleting = false;
        this.currentVictoryMessageIndex = (this.currentVictoryMessageIndex + 1) % this.victoryMessages().length;
        this.victoryTypingTimeout = setTimeout(() => this.runCyclingVictoryMessageAnimation(), 500);
      }
    } else {
      if (displayedText.length < currentMessage.length) {
        this.displayedVictoryMessage.update(val => currentMessage.slice(0, val.length + 1));
        this.victoryTypingTimeout = setTimeout(() => this.runCyclingVictoryMessageAnimation(), this.typingSpeed);
      } else {
        this.isVictoryMessageDeleting = true;
        this.victoryTypingTimeout = setTimeout(() => this.runCyclingVictoryMessageAnimation(), 3000);
      }
    }
  }

  private animateScore(): void {
    if (this.scoreAnimationTimer) clearInterval(this.scoreAnimationTimer);
    const finalScore = this.currentScore();
    this.displayedScore.set(0);
    if (finalScore === 0) return;

    const duration = 1500; // ms
    const stepTime = 20; // ms
    const steps = duration / stepTime;
    const increment = finalScore / steps;
    let current = 0;

    this.scoreAnimationTimer = setInterval(() => {
      current += increment;
      if (current >= finalScore) {
        this.displayedScore.set(finalScore);
        clearInterval(this.scoreAnimationTimer);
      } else {
        this.displayedScore.set(Math.ceil(current));
      }
    }, stepTime);
  }

  private async generateTimedChallengeSummary(): Promise<void> {
      this.victoryMessages.set(["Great effort! You really raced against the clock."]);
      const stats = this.finalTimedStats();
      if (!stats) return;

      try {
          const ai = new GoogleGenAI({ apiKey: process.env.API_KEY as string });
          const prompt = `Act as an energetic game announcer. Write a short, exciting summary of a player's performance in a ${stats.duration}-minute timed challenge on ${stats.difficulty}x${stats.difficulty} difficulty. They cleared ${stats.puzzlesCleared} puzzles and made a total of ${stats.totalMoves} moves. Be enthusiastic and do not include quotation marks.`;
          const response = await ai.models.generateContent({ model: 'gemini-2.5-flash', contents: prompt });
          let text = response.text;
          if (text) {
              this.victoryMessages.set([text.trim().replace(/^"|"$/g, '')]);
          }
      } catch (error) {
          console.error("Error generating timed challenge summary:", error);
      }
  }

  private calculateAndSaveScore(timeTakenMs: number): void {
    const gridSize = this.gridSize();
    const moves = this.moveCount();
    const difficultyMultiplier = Math.pow(gridSize, 4) * 100;
    const timePenalty = Math.floor(timeTakenMs / 50);
    const movePenalty = moves * (gridSize * 10);
    const score = Math.max(0, Math.floor(difficultyMultiplier - timePenalty - movePenalty));
    this.currentScore.set(score);
    const newScore: Score = { score, moves, time: timeTakenMs, date: Date.now() };
    this.leaderboard.update(currentLeaderboard => {
        const key = String(gridSize) as keyof Leaderboard;
        const boardForDifficulty = [...currentLeaderboard[key]];
        boardForDifficulty.push(newScore);
        boardForDifficulty.sort((a, b) => b.score - a.score);
        currentLeaderboard[key] = boardForDifficulty.slice(0, 5);
        return currentLeaderboard;
    });
    this.saveLeaderboard();
  }

  private launchConfetti(): void {
    const duration = 5 * 1000;
    const animationEnd = Date.now() + duration;
    const defaults = { startVelocity: 30, spread: 360, ticks: 60, zIndex: 100 };

    function randomInRange(min: number, max: number) {
      return Math.random() * (max - min) + min;
    }

    const interval = setInterval(() => {
      const timeLeft = animationEnd - Date.now();

      if (timeLeft <= 0) {
        return clearInterval(interval);
      }

      const particleCount = 50 * (timeLeft / duration);
      confetti({ ...defaults, particleCount, origin: { x: randomInRange(0.1, 0.3), y: Math.random() - 0.2 } });
      confetti({ ...defaults, particleCount, origin: { x: randomInRange(0.7, 0.9), y: Math.random() - 0.2 } });
    }, 250);
  }

  private loadLeaderboard(): void {
    try {
        const data = localStorage.getItem(LEADERBOARD_KEY);
        if (data) {
            const parsed = JSON.parse(data) as Leaderboard;
            if (parsed['3'] && parsed['4'] && parsed['5']) this.leaderboard.set(parsed);
        }
    } catch (e) { console.error("Failed to load leaderboard from localStorage", e); }
  }

  private saveLeaderboard(): void {
      try {
          localStorage.setItem(LEADERBOARD_KEY, JSON.stringify(this.leaderboard()));
      } catch (e) { console.error("Failed to save leaderboard to localStorage", e); }
  }

  setActiveLeaderboardTab(size: 3 | 4 | 5): void { this.activeLeaderboardTab.set(size); }

  formatLeaderboardTime(ms: number): string {
    const totalSeconds = Math.floor(ms / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    const milliseconds = Math.floor((ms % 1000) / 10);
    return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(milliseconds).padStart(2, '0')}`;
  }
}