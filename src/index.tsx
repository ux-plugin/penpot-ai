import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import wrapInProviders from "@/providers/wrapInProviders.tsx";

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
    <React.StrictMode>
        {wrapInProviders({children: <App/>})}
    </React.StrictMode>
);

