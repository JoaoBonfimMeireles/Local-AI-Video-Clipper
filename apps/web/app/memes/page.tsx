import { Suspense } from 'react';
import { MemeStudio } from '@/components/meme-studio';

export default function MemesPage() {
  return (
    <Suspense>
      <MemeStudio />
    </Suspense>
  );
}
