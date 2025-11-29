import { toast } from 'sonner';

export function showErrorToast(err: unknown, fallbackMessage?: string) {
  let message: string | undefined;

  if (typeof err === 'string') {
    message = err;
  } else if (err instanceof Error) {
    message = err.message;
  } else if (err && typeof err === 'object' && 'message' in err && typeof (err as any).message === 'string') {
    message = (err as any).message as string;
  }

  toast.error(message || fallbackMessage || 'An unexpected error occurred.');
}

export function showSuccessToast(message: string) {
  toast.success(message);
}

