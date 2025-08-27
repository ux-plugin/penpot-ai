import {useState} from "react";
import {LoginForm} from "@/components/login-form.tsx";
import {invoke} from '@tauri-apps/api/core'

export function LoginView() {
    const [email, setEmail] = useState("");
    const [password, setPassword] = useState("");

    const handleGithubLogin = () => {
        console.log("GitHub login clicked");
    };

    const handleGoogleLogin = () => {
        console.log("Google login clicked");
    };

    const handleEmailLogin = async (e: React.FormEvent) => {
        e.preventDefault();
        await invoke("greet", {name: "dhiaeddine"}).then((res) => console.log(res)).catch((error)=> console.log(error));
    };

    return (
        <div className="flex flex-col items-center justify-center min-h-screen bg-gray-100 p-6 md:p-8">
            <LoginForm
                email={email}
                password={password}
                onEmailChange={(e) => setEmail(e.target.value)}
                onPasswordChange={(e) => setPassword(e.target.value)}
                onEmailLogin={handleEmailLogin}
                onGoogleLogin={handleGoogleLogin}
                onGithubLogin={handleGithubLogin}
                className="max-w-md w-full"
            />
        </div>
    );
}