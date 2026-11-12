import { type APIRequest, BasePermission, SAFE_METHODS } from '@ghuri/rest'
import type { Post } from './models'

/** Anyone may read; only the author (or staff) may change or delete a post. */
export class IsAuthorOrReadOnly extends BasePermission {
  message = 'Only the author can change this post.'

  async hasObjectPermission(request: APIRequest, _view: unknown, post: Post) {
    if (SAFE_METHODS.includes(request.method)) return true
    return post.authorId === request.user.pk || request.user.isStaff === true
  }
}
