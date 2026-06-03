import React from 'react';
import { Panel } from '@/plugin-ui/components/Panel.tsx';
import { useNavigate } from 'react-router-dom';
import { Button } from '@ui/button';
import { Edit, LogOut, Trash2 } from 'lucide-react';
import { useAuthenticationStore } from '@/plugin-ui/stores/useAuthenticationStore.ts';
import { useUserSettingsStore } from '@/plugin-ui/stores/useUserSettingsStore.ts';
import SocialLoginItem from '@/plugin-ui/components/auth/SocialLoginItem.tsx';
import { AddSocialAccountMenu } from '@/plugin-ui/components/auth/AddSocialAccountMenu.tsx';
import ProfileSection from '@/plugin-ui/components/user/ProfileSection.tsx';
import { StatusDetailed } from '@/plugin-ui/components/status/StatusDetailed.tsx';

interface SettingsPanelProps {
  isOpen: boolean;
  onClose: () => void;
}

export const SettingsPanel: React.FC<SettingsPanelProps> = ({ isOpen, onClose }) => {
  const navigate = useNavigate();
  const { keyboardShortcut, socialLogins, deleteSocialLogin } = useUserSettingsStore();
  const { setAuthenticated, setRefreshToken, setAccessToken, setAuthProvider } = useAuthenticationStore();

  const handleLogout = () => {
    setAuthenticated(false);
    setRefreshToken(null, null);
    setAccessToken(null);
    setAuthProvider(null);
    onClose();
    navigate('/login');
  };

  return (
    <Panel isOpen={isOpen} onClose={onClose} title="Settings">
      <div className="space-y-6">
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
              Array.from(socialLogins).map((socialLogin) => (
                <SocialLoginItem
                  key={socialLogin.id || socialLogin.provider}
                  socialLogin={socialLogin}
                  onDisconnect={deleteSocialLogin}
                />
              ))
            )}
          </div>
        </div>

        {/* Connection status Section */}
        <div className="bg-gray-50 p-4 rounded-lg shadow-sm">
          <h2 className="text-md font-semibold">Connection status</h2>
          <p className="text-sm text-gray-500 mb-4">Manage connections to the server and companion app</p>
          <StatusDetailed />
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
                  <kbd className="px-2 py-1 bg-gray-200 rounded-md shadow-sm border border-gray-300 text-gray-800 font-sans">
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
    </Panel>
  );
};