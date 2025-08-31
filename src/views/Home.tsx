import { Button } from '@/components/ui/button';
import { Settings, Mic } from 'lucide-react';
import { useUserSettingsStore } from '@/stores/useUserSettingsStore.ts';
import { useNavigate } from "react-router-dom";
import React, { useEffect } from "react";
import { useAuthenticationStore } from "@/stores/useAuthenticationStore";
import { useUserConfigQuery } from "@/api/user/fetchUserConfig.ts";

function Home() {
  const { keyboardShortcut, setUserConfig } = useUserSettingsStore();
  const { setUserId } = useAuthenticationStore();
  const navigate = useNavigate();

  const { data } = useUserConfigQuery({ enabled: true });
  
  useEffect(() => {
    if (data) {
      setUserId(data.id);
      setUserConfig(data);
    }
  }, [data, setUserConfig, setUserId]);

  return (
    <div className="min-h-screen bg-white text-black flex flex-col">
      {/* Header */}
      <div className="flex justify-between items-center px-6 py-4">
        <div className="flex items-center space-x-2">
          <span className="w-2 h-2 bg-black rounded-full"></span>
          <h1 className="text-lg font-semibold">AI Voice Assistant</h1>
        </div>
        <Button variant="ghost" size="icon" className="text-gray-800 hover:bg-gray-100" onClick={() => navigate('/settings')}>
          <Settings className="h-5 w-5" />
        </Button>
      </div>

      {/* Main content */}
      <div className="flex flex-col items-center justify-center flex-1">
        <Button className="w-32 h-32 rounded-full bg-black flex items-center justify-center shadow-lg" size="icon">
          <Mic className="h-16 w-16 text-white" />
        </Button>
        <p className="mt-4 text-lg font-medium">Ready</p>

        {/* Shortcut indication */}
        <div className="mt-8 flex items-center text-sm text-gray-600">
          <span className="mr-2">Press</span>
          {keyboardShortcut.map((key, index) => (
            <React.Fragment key={index}>
              <kbd key={index} className="px-2 py-1 bg-gray-200 rounded-md shadow-sm border border-gray-300 text-gray-800 font-sans">
                {key}
              </kbd>
              {index < keyboardShortcut.length - 1 && <span className="mx-0.5">+</span>}
            </React.Fragment>
          ))}
          <span className="ml-2">to record</span>
        </div>
      </div>
    </div>
  );
}

export default Home;