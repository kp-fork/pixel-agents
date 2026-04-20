import { launchDesktopApp, stopDesktopApp } from './lib/desktopAppControl.js';

async function main(): Promise<void> {
	const stopped = await stopDesktopApp();
	console.log(`[app:restart] stopped terminated=${stopped.terminated} forceKilled=${stopped.forceKilled}`);
	await launchDesktopApp();
	console.log('[app:restart] ready');
}

main().catch((error) => {
	console.error(`[app:restart] failed: ${error instanceof Error ? error.message : String(error)}`);
	process.exit(1);
});
