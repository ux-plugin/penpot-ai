import { useEffect } from 'react';
import { Route, Routes } from 'react-router-dom';
import { Layout } from './components/Layout';
import { Home } from './pages/Home';
import { Login } from './pages/Login';
import { Catalog } from './pages/Catalog';
import { Cart } from './pages/Cart';
import { SessionsList } from './pages/SessionsList';
import { ReplayPage } from './pages/ReplayPage';
import { startRecorder } from './lib/recorder';

export default function App() {
  useEffect(() => {
    // StrictMode double-invokes effects in dev — guard so we don't start two recorders.
    if ((window as unknown as { __recorderStarted?: true }).__recorderStarted) return;
    (window as unknown as { __recorderStarted?: true }).__recorderStarted = true;
    startRecorder();
  }, []);

  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<Home />} />
        <Route path="login" element={<Login />} />
        <Route path="catalog" element={<Catalog />} />
        <Route path="cart" element={<Cart />} />
        <Route path="_/sessions" element={<SessionsList />} />
        <Route path="_/sessions/:sessionId" element={<ReplayPage />} />
      </Route>
    </Routes>
  );
}
