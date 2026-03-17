import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';

// Access document via window and cast to any to handle environments where DOM types are missing in the global scope
const rootElement = (window as any).document.getElementById('root');
if (!rootElement) {
  throw new Error("Could not find root element to mount to");
}

const root = ReactDOM.createRoot(rootElement);
root.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);