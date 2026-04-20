import { stopDesktopApp } from './lib/desktopAppControl.js';

async function main(): Promise<void> {
	const result = await stopDesktopApp();
	console.log(`[app:stop] terminated=${result.terminated} forceKilled=${result.forceKilled}`);
}

main().catch((error) => {
	console.error(`[app:stop] failed: ${error instanceof Error ? error.message : String(error)}`);
	process.exit(1);
});
