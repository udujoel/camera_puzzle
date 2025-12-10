import { Component, signal, ChangeDetectionStrategy, ViewChild, ElementRef, OnDestroy, WritableSignal } from '@angular/core';

const GRID_SIZE = 3;
const PUZZLE_DIMENSION = 600; // Should be easily divisible by GRID_SIZE

interface AnimationState {
  index1: number;
  index2: number;
  startTime: number;
  duration: number;
}

@Component({
  selector: 'app-root',
  templateUrl: './app.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AppComponent implements OnDestroy {
  @ViewChild('videoElement') videoElement!: ElementRef<HTMLVideoElement>;
  @ViewChild('puzzleCanvas') puzzleCanvas?: ElementRef<HTMLCanvasElement>;

  gameState: WritableSignal<'idle' | 'playing' | 'won' | 'error'> = signal('idle');
  cameraError: WritableSignal<string | null> = signal(null);
  tiles: WritableSignal<number[]> = signal([]);
  selectedTileIndex: WritableSignal<number | null> = signal(null);
  isShuffling = signal(false);

  private stream: MediaStream | null = null;
  private animationFrameId: number | null = null;
  private currentAnimation: AnimationState | null = null;
  
  // Make PUZZLE_DIMENSION available to the template
  public readonly PUZZLE_DIMENSION = PUZZLE_DIMENSION;

  constructor() {
    const initialTiles = Array.from({ length: GRID_SIZE * GRID_SIZE }, (_, i) => i);
    this.tiles.set(initialTiles);
  }

  ngOnDestroy(): void {
    this.stopGame();
  }

  async startGame(): Promise<void> {
    this.gameState.set('playing');
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ video: { width: PUZZLE_DIMENSION, height: PUZZLE_DIMENSION } });
      const video = this.videoElement.nativeElement;
      video.srcObject = this.stream;
      video.onplaying = () => {
        this.initializePuzzle();
      };
    } catch (err) {
      this.handleCameraError(err);
    }
  }

  private initializePuzzle(): void {
    const canvas = this.puzzleCanvas?.nativeElement;
    if (canvas) {
      canvas.width = PUZZLE_DIMENSION;
      canvas.height = PUZZLE_DIMENSION;
    }
    this.shuffleTiles();
    this.gameLoop();
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
    this.gameState.set('idle');
  }

  private stopGame(): void {
    if (this.animationFrameId) {
      cancelAnimationFrame(this.animationFrameId);
      this.animationFrameId = null;
    }
    this.stream?.getTracks().forEach(track => track.stop());
    this.stream = null;
    const initialTiles = Array.from({ length: GRID_SIZE * GRID_SIZE }, (_, i) => i);
    this.tiles.set(initialTiles);
    this.isShuffling.set(false);
  }
  
  private async shuffleTiles(): Promise<void> {
    this.isShuffling.set(true);
    let currentTiles = [...this.tiles()];
    
    // Fisher-Yates shuffle
    for (let i = currentTiles.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [currentTiles[i], currentTiles[j]] = [currentTiles[j], currentTiles[i]];
    }

    // Ensure it's not already solved
    if (this.isSolved(currentTiles)) {
      // Simple swap to guarantee it's not solved
      [currentTiles[0], currentTiles[1]] = [currentTiles[1], currentTiles[0]];
    }
    
    this.tiles.set(currentTiles);

    // Animate the shuffle
    const shuffleAnimations: { index1: number; index2: number }[] = [];
    for (let i = 0; i < GRID_SIZE * GRID_SIZE * 2; i++) {
      shuffleAnimations.push({
        index1: Math.floor(Math.random() * (GRID_SIZE * GRID_SIZE)),
        index2: Math.floor(Math.random() * (GRID_SIZE * GRID_SIZE)),
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

    const tileWidth = canvas.width / GRID_SIZE;
    const tileHeight = canvas.height / GRID_SIZE;
    const col = Math.floor(x / tileWidth);
    const row = Math.floor(y / tileHeight);
    const clickedIndex = row * GRID_SIZE + col;
    
    const selectedIdx = this.selectedTileIndex();
    if (selectedIdx === null) {
      this.selectedTileIndex.set(clickedIndex);
    } else {
      if (selectedIdx !== clickedIndex) {
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
    this.animationFrameId = requestAnimationFrame(this.gameLoop);
  };
  
  private drawScrambledVideo(): void {
    const canvas = this.puzzleCanvas?.nativeElement;
    const video = this.videoElement.nativeElement;
    if (!canvas || !video || video.readyState < video.HAVE_METADATA) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const tileWidth = PUZZLE_DIMENSION / GRID_SIZE;
    const tileHeight = PUZZLE_DIMENSION / GRID_SIZE;
    
    const videoWidth = video.videoWidth;
    const videoHeight = video.videoHeight;
    const sourceSize = Math.min(videoWidth, videoHeight);
    const sx = (videoWidth - sourceSize) / 2;
    const sy = (videoHeight - sourceSize) / 2;

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const currentTiles = this.tiles();

    for (let i = 0; i < currentTiles.length; i++) {
      const tileValue = currentTiles[i];
      const sourceCol = tileValue % GRID_SIZE;
      const sourceRow = Math.floor(tileValue / GRID_SIZE);

      const destCol = i % GRID_SIZE;
      const destRow = Math.floor(i / GRID_SIZE);
      
      let destX = destCol * tileWidth;
      let destY = destRow * tileHeight;

      if (this.currentAnimation) {
          const { index1, index2, startTime, duration } = this.currentAnimation;
          const elapsedTime = performance.now() - startTime;
          let progress = Math.min(elapsedTime / duration, 1);
          
          // Apply an ease-in-out timing function for a smoother animation
          const easeInOutQuad = (t: number) => t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t;
          progress = easeInOutQuad(progress);

          const startCol1 = index1 % GRID_SIZE;
          const startRow1 = Math.floor(index1 / GRID_SIZE);
          const endCol1 = index2 % GRID_SIZE;
          const endRow1 = Math.floor(index2 / GRID_SIZE);

          if (i === index1) {
            destX = (startCol1 + (endCol1 - startCol1) * progress) * tileWidth;
            destY = (startRow1 + (endRow1 - startRow1) * progress) * tileHeight;
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
        sx + sourceCol * (sourceSize / GRID_SIZE),
        sy + sourceRow * (sourceSize / GRID_SIZE),
        sourceSize / GRID_SIZE,
        sourceSize / GRID_SIZE,
        destX,
        destY,
        tileWidth,
        tileHeight
      );
    }

    // Highlight the selected tile
    const selectedIdx = this.selectedTileIndex();
    if (selectedIdx !== null && !this.currentAnimation && this.gameState() === 'playing') {
      const col = selectedIdx % GRID_SIZE;
      const row = Math.floor(selectedIdx / GRID_SIZE);

      ctx.strokeStyle = 'rgba(56, 189, 248, 0.9)'; // A bright blue (sky-400)
      ctx.lineWidth = 4;
      ctx.strokeRect(col * tileWidth + 2, row * tileHeight + 2, tileWidth - 4, tileHeight - 4);
    }
  }

  private checkWinCondition(): void {
    if (this.isSolved(this.tiles())) {
      this.gameState.set('won');
    }
  }
}