import { Skeleton } from '@/components/ui/skeleton';

/** Aparece na hora em que um link é clicado, enquanto a próxima página carrega. */
export default function Loading() {
  return (
    <div className="space-y-4">
      <Skeleton className="h-7 w-64" />
      <Skeleton className="h-4 w-96 max-w-full" />
      <div className="grid gap-4 md:grid-cols-2">
        <Skeleton className="h-48" />
        <Skeleton className="h-48" />
      </div>
    </div>
  );
}
