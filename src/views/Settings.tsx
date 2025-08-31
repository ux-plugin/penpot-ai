import React from "react";
import { useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { ArrowLeft, Edit, LogOut, Trash2 } from 'lucide-react';
import { useAuthenticationStore } from '@/stores/useAuthenticationStore.ts';
import { useUserSettingsStore } from '@/stores/useUserSettingsStore.ts';
import SocialLoginItem from '@/components/SocialLoginItem';
import { AddSocialAccountMenu } from '@/components/AddSocialAccountMenu.tsx';
import ProfileSection from '@/components/ProfileSection'; // Import the new component

function Settings() {
  const navigate = useNavigate();
  const { keyboardShortcut, socialLogins, deleteSocialLogin } = useUserSettingsStore();
  const { setAuthenticated, setRefreshToken, setAccessToken, setAuthProvider } = useAuthenticationStore();
  // TODO: Fetch user configuration from the server, figure out if we want to make this a provider or not.
  const handleLogout = () => {
    setAuthenticated(false);
    setRefreshToken('');
    setAccessToken('');
    setAuthProvider(null);
    navigate('/login');
  };

  return (
    <div className="min-h-screen bg-white text-black flex flex-col">
      {/* Header */}
      <div className="flex items-center px-6 py-4 border-b border-gray-200">
        <Button variant="ghost" size="icon" className="text-gray-800" onClick={() => navigate('/')}>
          <ArrowLeft className="h-5 w-5" />
        </Button>
        <h1 className="text-lg font-semibold ml-4">Settings</h1>
      </div>

      <div className="flex-1 p-6 space-y-8">
        {/* Profile Section */}
        <ProfileSection />

        {/* Connected Accounts Section */}
        <div className="bg-gray-50 p-4 rounded-lg shadow-sm">
          <div className="flex items-center justify-between">
            <h2 className="text-md font-semibold">Connected Accounts</h2>
            <AddSocialAccountMenu />
          </div>
          <p className="text-sm text-gray-500 mb-4">Manage your connected social accounts</p>
          <div className="space-y-4">
            {socialLogins.size === 0 ? (
              <p className="text-sm text-gray-500">No social accounts connected.</p>
            ) : (
              // Dynamically render SocialLoginItem for each connected social account
              Array.from(socialLogins).map((socialLogin) => (
                <SocialLoginItem
                  key={socialLogin.id || socialLogin.provider} // Use id if available, fallback to provider for key
                  socialLogin={socialLogin}
                  onDisconnect={deleteSocialLogin} // Pass the store's delete function directly
                />
              ))
            )}
          </div>
        </div>

        {/* Keyboard Shortcut Section */}
        <div className="bg-gray-50 p-4 rounded-lg shadow-sm">
          <h2 className="text-md font-semibold">Keyboard Shortcut</h2>
          <p className="text-sm text-gray-500 mb-4">Customize the key combination to start recording</p>
          <div className="flex items-center justify-between py-2">
            <p className="font-medium">Current shortcut:</p>
            <div className="flex items-center space-x-1">
              {keyboardShortcut.map((key, index) => (
                <React.Fragment key={index}>
                  <kbd key={index} className="px-2 py-1 bg-gray-200 rounded-md shadow-sm border border-gray-300 text-gray-800 font-sans">
                    {key}
                  </kbd>
                  {index < keyboardShortcut.length - 1 && <span className="mx-0.5">+</span>}
                </React.Fragment>
              ))}
            </div>
            <Button variant="ghost" size="icon" className="text-gray-800 hover:bg-gray-100">
              <Edit className="h-4 w-4" />
            </Button>
          </div>
        </div>

        {/* Account Actions Section */}
        <div className="bg-gray-50 p-4 rounded-lg shadow-sm">
          <h2 className="text-md font-semibold">Account Actions</h2>
          <p className="text-sm text-gray-500 mb-4">Manage your account</p>
          <div className="space-y-4">
            <Button
              variant="outline"
              className="w-full justify-start text-gray-700 border-gray-300"
              onClick={handleLogout}
            >
              <LogOut className="h-4 w-4 mr-2" />
              Logout
            </Button>
            <Button variant="destructive" className="w-full justify-start">
              <Trash2 className="h-4 w-4 mr-2" />
              Delete Account
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

export default Settings;