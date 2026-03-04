import { BrowserWindow } from 'electrobun';

function run(): void {
	const window = new BrowserWindow({
		title: 'Pixel Agents Desktop',
		frame: { x: 120, y: 80, width: 1280, height: 840 },
		url: 'views://pixel/index.html',
		renderer: 'native',
		titleBarStyle: 'default',
		transparent: false,
	});

	console.log('[desktop-electrobun] loading views://pixel/index.html');
	window.on('dom-ready', () => {
		console.log('[desktop-electrobun] webview DOM ready');
	});
}

run();
