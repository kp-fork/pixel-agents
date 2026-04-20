import { launchDesktopApp } from './lib/desktopAppControl.js';

async function main(): Promise<void> {
	await launchDesktopApp();
	console.log('[app:launch] ready');
}

main().catch((error) => {
	console.error(`[app:launch] failed: ${error instanceof Error ? error.message : String(error)}`);
	process.exit(1);
});
