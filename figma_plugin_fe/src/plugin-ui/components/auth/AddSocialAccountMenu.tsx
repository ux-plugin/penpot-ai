import { Button } from '@ui/button';
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem } from '@ui/dropdown-menu';
import { Plus } from 'lucide-react';
import { FigmaIcon } from '@assets/icons/FigmaIcon.tsx'; // Import your custom FigmaIcon
import { GitHubIcon } from '@assets/icons/GithubIcon.tsx';
import { useGitHubConnect } from "@/plugin-ui/api/auth/connectGithub.ts"; // Import your custom GitHubIcon
import { useFigmaConnect } from "@/plugin-ui/api/auth/connectFigma.ts"; // Import useFigmaConnect
import { Loader2 } from "lucide-react"; // Import Loader2
import { showErrorToast, showSuccessToast } from '@/plugin-ui/utils/showErrorToast.ts';

/**
 * A component that provides a button to add social accounts via a dropdown menu.
 * It currently supports Figma and GitHub and simulates a connection with a fake ID.
 */
export function AddSocialAccountMenu() {
  const { isFetching: isGitHubPending, refetch: githubConnectRefetch } = useGitHubConnect();
  const { isFetching: isFigmaPending, refetch: figmaConnectRefetch } = useFigmaConnect();

  const handleFigmaConnect = async () => {
    const {error} = await figmaConnectRefetch()
    if (error) {
      showErrorToast('Figma connection failed');
      return
    }
    showSuccessToast('Figma account connected successfully');
    
  };

  const handleGitHubConnect = async () => {
    const { error } = await githubConnectRefetch();
    if (error) {
      showErrorToast("GitHub connection failed");
      return;
    }
    showSuccessToast("GitHub account connected successfully");
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