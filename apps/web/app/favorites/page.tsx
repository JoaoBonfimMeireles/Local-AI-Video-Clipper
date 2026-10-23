import { FavoritesList } from '@/components/favorites-list';

export default function FavoritesPage() {
  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold">Favoritos</h1>
        <p className="text-sm text-muted-foreground">
          Cortes que você marcou com a estrela. Cada um é uma cópia guardada à parte: reprocessar ou excluir o job não mexe aqui. Dá para pedir ajustes
          direto no favorito.
        </p>
      </div>
      <FavoritesList />
    </div>
  );
}
