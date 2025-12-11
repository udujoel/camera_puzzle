import { Component, signal, ChangeDetectionStrategy, ViewChild, ElementRef, OnDestroy, WritableSignal, computed, AfterViewInit } from '@angular/core';

const PUZZLE_DIMENSION = 600; // Should be easily divisible by grid sizes (3, 4, 5)

interface AnimationState {
  index1: number;
  index2: number;
  startTime: number;
  duration: number;
}

interface ConfettiParticle {
  left: string;
  background: string;
  width: string;
  height: string;
  animationDuration: string;
  animationDelay: string;
}

@Component({
  selector: 'app-root',
  templateUrl: './app.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AppComponent implements OnDestroy, AfterViewInit {
  @ViewChild('videoElement') videoElement!: ElementRef<HTMLVideoElement>;
  @ViewChild('puzzleCanvas') puzzleCanvas?: ElementRef<HTMLCanvasElement>;
  @ViewChild('previewCanvas') previewCanvas?: ElementRef<HTMLCanvasElement>;

  gameState: WritableSignal<'idle' | 'playing' | 'won' | 'error'> = signal('idle');
  cameraError: WritableSignal<string | null> = signal(null);
  gridSize = signal(3); // Default value, will be set on startGame
  tiles: WritableSignal<number[]> = signal([]);
  selectedTileIndex: WritableSignal<number | null> = signal(null);
  isShuffling = signal(false);
  moveCount = signal(0);
  timeTaken = signal(0); // in milliseconds
  confettiParticles = signal<ConfettiParticle[]>([]);
  showPreview = signal(false);
  showDifficultySelection = signal(false);
  typingState = signal<'pre-typing' | 'typing' | 'done'>('pre-typing');
  instructionText = "Unscramble your live camera feed! The image will be broken into tiles and shuffled. Click two tiles to swap them until the picture is correct.";
  instructionChars = this.instructionText.split('');
  charAnimationDelays: number[] = [];
  
  private stream: MediaStream | null = null;
  private animationFrameId: number | null = null;
  private currentAnimation: AnimationState | null = null;
  private startTime = 0;
  private previewTimer: any = null;
  private typingTimeout: any;
  
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

  constructor() {}

  ngAfterViewInit(): void {
    if (this.gameState() === 'idle') {
      this.startTypingAnimation();
    }
  }

  ngOnDestroy(): void {
    this.stopGame();
    if (this.previewTimer) {
        clearTimeout(this.previewTimer);
    }
    if (this.typingTimeout) {
      clearTimeout(this.typingTimeout);
    }
  }

  private prepareTypingAnimation(): void {
    this.charAnimationDelays = [];
    let delay = 0;
    this.instructionChars.forEach(char => {
      this.charAnimationDelays.push(delay);
      delay += 40; // Natural typing speed
      if (char === ' ' || char === '!' || char === '.') {
        delay += 200; // Pause after words/sentences for a batch effect
      }
    });
    const totalAnimationDuration = delay + 500; // Total time + buffer
    this.typingTimeout = setTimeout(() => {
      this.typingState.set('done');
    }, totalAnimationDuration);
  }

  async startGame(size: number): Promise<void> {
    this.gridSize.set(size);
    this.gameState.set('playing');
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ video: { width: PUZZLE_DIMENSION, height: PUZZLE_DIMENSION } });
      const video = this.videoElement.nativeElement;
      video.srcObject = this.stream;
      video.onplaying = () => {
        this.initializePuzzle();
        if (this.animationFrameId === null) {
            this.gameLoop();
        }
      };
    } catch (err) {
      this.handleCameraError(err);
    }
  }

  private initializePuzzle(): void {
    const gridSize = this.gridSize();
    const initialTiles = Array.from({ length: gridSize * gridSize }, (_, i) => i);
    this.tiles.set(initialTiles);

    const canvas = this.puzzleCanvas?.nativeElement;
    const previewCanvas = this.previewCanvas?.nativeElement;
    if (canvas) {
      canvas.width = PUZZLE_DIMENSION;
      canvas.height = PUZZLE_DIMENSION;
    }
    if (previewCanvas) {
        previewCanvas.width = 120;
        previewCanvas.height = 120;
    }
    this.moveCount.set(0);
    this.timeTaken.set(0);
    this.startTime = performance.now();
    this.shuffleTiles();
    this.peekPreview();
  }
  
  restartPuzzle(): void {
      if (this.gameState() !== 'playing') return;
      this.initializePuzzle();
  }

  peekPreview(): void {
    if (this.previewTimer) {
        clearTimeout(this.previewTimer);
    }
    this.showPreview.set(true);
    this.previewTimer = setTimeout(() => this.showPreview.set(false), 2500);
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
    this.confettiParticles.set([]);
    this.showDifficultySelection.set(false);
    this.gameState.set('idle');
    this.startTypingAnimation();
  }

  private stopGame(): void {
    if (this.animationFrameId) {
      cancelAnimationFrame(this.animationFrameId);
      this.animationFrameId = null;
    }
    if (this.previewTimer) {
        clearTimeout(this.previewTimer);
        this.previewTimer = null;
    }
    if (this.typingTimeout) {
      clearTimeout(this.typingTimeout);
    }
    this.showPreview.set(false);
    this.stream?.getTracks().forEach(track => track.stop());
    this.stream = null;
    this.tiles.set([]);
    this.isShuffling.set(false);
    
    if(this.previewCanvas) {
        const previewCtx = this.previewCanvas.nativeElement.getContext('2d');
        previewCtx?.clearRect(0, 0, this.previewCanvas.nativeElement.width, this.previewCanvas.nativeElement.height);
    }
  }

  private startTypingAnimation(): void {
    this.typingState.set('pre-typing');
    if (this.typingTimeout) {
      clearTimeout(this.typingTimeout);
    }
    // Wait for 2 blinks (1.5s for 0.75s blink animation)
    this.typingTimeout = setTimeout(() => {
      this.typingState.set('typing');
      this.prepareTypingAnimation();
    }, 1500);
  }
  
  toggleDifficultySelection(): void {
    this.showDifficultySelection.update(v => !v);
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
    for (let i = 0; i < tileCount * 2; i++) {
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
      if (tiles[i] !== i) {
        return false;
      }
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
    
    const selectedIdx = this.selectedTileIndex();
    if (selectedIdx === null) {
      this.selectedTileIndex.set(clickedIndex);
    } else {
      if (selectedIdx !== clickedIndex) {
        this.moveCount.update(c => c + 1);
        this.swapTiles(selectedIdx, clickedIndex, 200);
      }
      this.selectedTileIndex.set(null);
    }
  }

  private swapTiles(index1: number, index2: number, duration: number): void {
    this.currentAnimation = { index1, index2, startTime: performance.now(), duration };
  }

  private gameLoop = (): void => {
    this.drawScrambledVideo();
    if(this.gameState() === 'playing') {
      this.drawPreview();
    }
    this.animationFrameId = requestAnimationFrame(this.gameLoop);
  };
  
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
            destY = (startRow1 + (endRow1 - startCol1) * progress) * tileHeight;
          } else if (i === index2) {
            destX = (endCol1 - (endCol1 - startCol1) * progress) * tileWidth;
            destY = (endRow1 - (endRow1 - startRow1) * progress) * tileHeight;
          }

          if (progress >= 1) {
            const tilesCopy = [...currentTiles];
            [tilesCopy[index1], tilesCopy[index2]] = [tilesCopy[index2], tilesCopy[index1]];
            this.tiles.set(tilesCopy);
            this.currentAnimation = null;
            if (!this.isShuffling()) {
                this.checkWinCondition();
            }
          }
      }

      ctx.drawImage(
        video,
        sx + sourceCol * (sourceSize / gridSize),
        sy + sourceRow * (sourceSize / gridSize),
        sourceSize / gridSize,
        sourceSize / gridSize,
        destX,
        destY,
        tileWidth,
        tileHeight
      );
    }

    const selectedIdx = this.selectedTileIndex();
    if (selectedIdx !== null && !this.currentAnimation && this.gameState() === 'playing') {
      const col = selectedIdx % gridSize;
      const row = Math.floor(selectedIdx / gridSize);

      ctx.strokeStyle = 'rgba(56, 189, 248, 0.9)';
      ctx.lineWidth = 4;
      ctx.strokeRect(col * tileWidth + 2, row * tileHeight + 2, tileWidth - 4, tileHeight - 4);
    }
  }

  private drawPreview(): void {
    const previewCanvas = this.previewCanvas?.nativeElement;
    const video = this.videoElement.nativeElement;
    if (!previewCanvas || !video || video.readyState < video.HAVE_METADATA) return;
    
    const ctx = previewCanvas.getContext('2d');
    if (!ctx) return;

    const videoWidth = video.videoWidth;
    const videoHeight = video.videoHeight;
    const sourceSize = Math.min(videoWidth, videoHeight);
    const sx = (videoWidth - sourceSize) / 2;
    const sy = (videoHeight - sourceSize) / 2;

    ctx.drawImage(
      video,
      sx,
      sy,
      sourceSize,
      sourceSize,
      0,
      0,
      previewCanvas.width,
      previewCanvas.height
    );
  }

  private checkWinCondition(): void {
    if (this.isSolved(this.tiles())) {
      const endTime = performance.now();
      this.timeTaken.set(endTime - this.startTime);
      this.gameState.set('won');
      this.launchConfetti();
    }
  }

  private launchConfetti(): void {
    const particles: ConfettiParticle[] = [];
    const colors = ['#fde047', '#f97316', '#ec4899', '#8b5cf6', '#3b82f6', '#22c55e'];
    for (let i = 0; i < 150; i++) {
      particles.push({
        left: `${Math.random() * 100}%`,
        background: colors[Math.floor(Math.random() * colors.length)],
        width: `${Math.random() * 8 + 6}px`,
        height: `${Math.random() * 6 + 4}px`,
        animationDuration: `${Math.random() * 3 + 4}s`,
        animationDelay: `${Math.random() * 3}s`
      });
    }
    this.confettiParticles.set(particles);
  }
}