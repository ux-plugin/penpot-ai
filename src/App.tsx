import "./App.css";
import {LoginView} from "@/views/LoginView.tsx";
import {BrowserRouter, Routes, Route, Navigate} from "react-router-dom";
import {Home} from "lucide-react";

function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={<LoginView />} />
          <Route path="/home" element={<Home />} />
        <Route path="/" element={<Navigate to="/home" replace />} />
      </Routes>
    </BrowserRouter>
  )
}

export default App;
