// REST API views for the blog (@ghuri/rest). Registered on the router in src/urls.ts.
import {
  type APIRequest,
  action,
  FieldFilter,
  IsAdminUser,
  IsAuthenticatedOrReadOnly,
  ModelViewSet,
  OrderingFilter,
  PageNumberPagination,
  SearchFilter,
} from '@ghuri/rest'
import { Q } from '@ghuri/orm'
import { Comment, Post, Tag } from './models'
import { IsAuthorOrReadOnly } from './permissions'
import { CommentSerializer, PostSerializer, TagSerializer } from './serializers'

export class BlogPagination extends PageNumberPagination {
  pageSize = 10
  pageSizeQueryParam = 'pageSize'
  maxPageSize = 100
}

export class PostViewSet extends ModelViewSet<Post> {
  queryset = Post.objects.all().selectRelated('author').prefetchRelated('tags')
  serializerClass = PostSerializer
  permissionClasses = [IsAuthenticatedOrReadOnly, IsAuthorOrReadOnly]
  paginationClass = BlogPagination
  filterBackends = [SearchFilter, OrderingFilter, FieldFilter]
  searchFields = ['title', 'body', 'author__username', 'tags__name']
  orderingFields = ['createdAt', 'title', 'updatedAt']
  ordering = ['-createdAt']
  filtersetFields = { published: ['exact'], tags__slug: ['exact'], createdAt: ['gte', 'lte'] }
  lookupField = 'slug'

  /** Drafts are visible to their author (and staff) only. */
  getQueryset() {
    const qs = super.getQueryset()
    const user = this.request.user
    if (user.isStaff) return qs
    if (user.isAuthenticated) return qs.filter(Q({ published: true }).or(Q({ author: user.pk })))
    return qs.filter({ published: true })
  }

  async performCreate(serializer: PostSerializer) {
    await serializer.save({ author: this.request.user })
  }

  @action({ detail: true, methods: ['post'] })
  async publish(_request: APIRequest) {
    const post = await this.getObject()
    post.published = true
    await post.save({ updateFields: ['published', 'updatedAt'] })
    return { status: 'published', slug: post.slug }
  }

  @action({ detail: false, permissionClasses: [IsAdminUser] })
  async drafts(_request: APIRequest) {
    const serializer = this.getSerializer({
      instance: await Post.objects.filter({ published: false }),
      many: true,
    })
    return serializer.getData()
  }
}

export class TagViewSet extends ModelViewSet<Tag> {
  queryset = Tag.objects.all()
  serializerClass = TagSerializer
  permissionClasses = [IsAuthenticatedOrReadOnly]
  lookupField = 'slug'
  filterBackends = [SearchFilter]
  searchFields = ['name']
}

export class CommentViewSet extends ModelViewSet<Comment> {
  queryset = Comment.objects.filter({ approved: true })
  serializerClass = CommentSerializer
  permissionClasses = [IsAuthenticatedOrReadOnly]
  filterBackends = [FieldFilter, OrderingFilter]
  filtersetFields = ['post']
  orderingFields = ['createdAt']
}
