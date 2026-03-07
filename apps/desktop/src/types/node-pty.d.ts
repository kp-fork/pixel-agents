declare module '@lydell/node-pty' {
  export interface IDisposable {
    dispose(): void;
  }

  export interface IPtyExitEvent {
    exitCode: number;
    signal?: number;
  }

  export interface IPty {
    readonly cols: number;
    readonly rows: number;
    write(data: string | Buffer): void;
    resize(cols: number, rows: number): void;
    kill(signal?: string): void;
    onData(listener: (data: string) => void): IDisposable;
    onExit(listener: (event: IPtyExitEvent) => void): IDisposable;
  }

  export function spawn(
    file: string,
    args: string[] | string,
    options: {
      name?: string;
      cols?: number;
      rows?: number;
      cwd?: string;
      env?: Record<string, string | undefined>;
    }
  ): IPty;

  const pty: {
    spawn: typeof spawn;
  };

  export default pty;
}
