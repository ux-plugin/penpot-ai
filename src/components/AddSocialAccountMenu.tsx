import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem } from '@/components/ui/dropdown-menu';
import { Plus } from 'lucide-react';
import { FigmaIcon } from '@/assets/FigmaIcon'; // Import your custom FigmaIcon
import { GitHubIcon } from '@/assets/GithubIcon';
import { useGitHubConnect } from "@/api/auth/connectGithub.ts"; // Import your custom GitHubIcon
import { useFigmaConnect } from "@/api/auth/connectFigma.ts"; // Import useFigmaConnect
import { Loader2 } from "lucide-react"; // Import Loader2

/**
 * A component that provides a button to add social accounts via a dropdown menu.
 * It currently supports Figma and GitHub and simulates a connection with a fake ID.
 */
export function AddSocialAccountMenu() {
  const { isFetching: isGitHubPending, refetch: githubConnectRefetch } = useGitHubConnect();
  const { isFetching: isFigmaPending, refetch: figmaConnectRefetch } = useFigmaConnect();

  const handleFigmaConnect = async () => {
    try {
      const result = await figmaConnectRefetch()
      if (result) {
        console.log('Figma connected successfully');
      } else {
        console.log('Figma connection failed');
      }
    } finally {
    }
  };

  const handleGitHubConnect = async () => {
    try {
      const result = await githubConnectRefetch()
      if (result) {
        console.log('GitHub connected successfully');
      } else {
        console.log('GitHub connection failed');
      }
    } finally {
      // No need to reset the local loading state, as isPending from hook will handle it
    }
  };

  // Combine the pending states from the hooks
  const isAnyConnecting = isGitHubPending || isFigmaPending;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm" className="text-gray-800">
          <Plus className="h-4 w-4 mr-1" /> Add Account
        </Button>
      </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          <DropdownMenuItem
            onClick={handleFigmaConnect}
            disabled={isAnyConnecting} // Disable if any operation is pending
          >
            {isAnyConnecting ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Please wait
              </>
            ) : (
              <>
                <FigmaIcon/>
                Figma
              </>
            )}
          </DropdownMenuItem>
          <DropdownMenuItem
            onClick={handleGitHubConnect}
            disabled={isAnyConnecting} // Disable if any operation is pending
          >
            {isAnyConnecting ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Please wait
              </>
            ) : (
              <>
                <GitHubIcon/>
                GitHub
              </>
            )}
          </DropdownMenuItem>
        </DropdownMenuContent>
    </DropdownMenu>
  );
}