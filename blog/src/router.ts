// The REST API router (its own module so agents and URLs can both import it without a cycle).
import { DefaultRouter } from '@ghuri/rest'
import { CommentViewSet, PostViewSet, TagViewSet } from './blog/views'

export const router = new DefaultRouter()
router.register('posts', PostViewSet)
router.register('tags', TagViewSet)
router.register('comments', CommentViewSet)
