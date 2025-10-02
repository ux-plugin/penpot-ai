import { Button } from '@ui/button';
import { Check } from 'lucide-react';

// Defines the structure for a social login object.
// This interface can be extended if more properties are needed (e.g., username, profile picture).
interface SocialLogin {
  provider: 'FIGMA' | 'GITHUB'; // Current supported providers; can be extended
  id: string; // Unique identifier for the connection, used for disconnection
}

interface SocialLoginItemProps {
  socialLogin: SocialLogin;
  onDisconnect: (provider: SocialLogin['provider'], id: string) => void;
}

/**
 * A reusable component to display a single connected social account.
 * It shows the provider name, a 'Connected' status, and a disconnect button.
 */
function SocialLoginItem({ socialLogin, onDisconnect }: SocialLoginItemProps) {
  // Format the provider name for display (e.g., 'FIGMA' -> 'Figma')
  const providerDisplayName = socialLogin.provider.charAt(0).toUpperCase() + socialLogin.provider.slice(1).toLowerCase();
  // Get the first letter of the provider for a simple icon placeholder
  const iconLetter = socialLogin.provider.charAt(0).toUpperCase();

  return (
    <div className="flex items-center justify-between py-2">
      <div className="flex items-center space-x-3">
        {/* Placeholder for the social account icon */}
        <div className="w-8 h-8 flex items-center justify-center rounded-md bg-gray-200 text-gray-700 font-bold">
          {iconLetter}
        </div>
        <div>
          <p className="font-medium">{providerDisplayName}</p>
          <p className="text-sm text-gray-500">
            <Check className="h-4 w-4 inline-block mr-1 text-green-600" /> Connected
          </p>
        </div>
      </div>
      <Button
        variant="destructive" // As requested, making the disconnect button red
        size="sm"
        className="w-24" // Gives a consistent width to the button
        onClick={() => onDisconnect(socialLogin.provider, socialLogin.id)}
      >
        Disconnect
      </Button>
    </div>
  );
}

export default SocialLoginItem;
