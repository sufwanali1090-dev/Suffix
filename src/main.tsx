/** React entry point. */

import React from 'react';
import ReactDOM from 'react-dom/client';
import App from '@/App';
import '@/index.css';

const root = document.getElementById('root');
if (!root) {
  throw new Error('SUFFIX: #root container missing from index.html');
}

ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
