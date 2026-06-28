import { render } from 'preact';
import { App } from './app';

// Default route so the shell always has a section selected.
if (!location.hash) location.hash = '/dashboard';

render(<App />, document.getElementById('app')!);
