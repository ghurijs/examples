// Admin registrations for the blog (@ghuri/admin). Importing this module (BlogConfig.admin) registers them.
import { action, admin, display, ModelAdmin, TabularInline } from '@ghuri/admin'
import type { QuerySet } from '@ghuri/orm'
import type { Context } from 'hono'
import { Comment, Post, Tag } from './models'

class CommentInline extends TabularInline<Comment> {
  model = Comment
  extra = 1
  fields = ['name', 'email', 'body', 'approved']
  readonlyFields = ['createdAt']
}

/** A site-wide style action written without decorators. */
export const makePublished = action(
  { name: 'make_published', description: 'Mark selected %(verbose_name_plural)s as published', permissions: ['change'] },
  async (modelAdmin: ModelAdmin, c: Context, queryset: QuerySet<Post>) => {
    const n = await queryset.update({ published: true })
    await modelAdmin.messageUser(c, `${n} post(s) were published.`, 'success')
  },
)

@admin.register(Post)
export class PostAdmin extends ModelAdmin<Post> {
  listDisplay = ['title', 'author', 'published', 'commentCount', 'createdAt']
  listFilter = ['published', 'tags', 'createdAt']
  searchFields = ['title', 'body', 'author__username']
  prepopulatedFields = { slug: ['title'] }
  readonlyFields = ['createdAt', 'updatedAt']
  filterHorizontal = ['tags']
  dateHierarchy = 'createdAt'
  ordering = ['-createdAt']
  listPerPage = 25
  inlines = [CommentInline]
  actions = [makePublished, 'unpublish']
  fieldsets = [
    [null, { fields: ['title', 'slug', 'body', 'cover'] }],
    ['Publishing', { fields: ['author', 'tags', 'published', 'createdAt', 'updatedAt'] }],
  ]

  @display({ description: 'Comments' })
  async commentCount(post: Post) {
    return Comment.objects.filter({ post: post.pk }).count()
  }

  @action({ description: 'Unpublish selected posts', permissions: ['change'] })
  async unpublish(c: Context, queryset: QuerySet<Post>) {
    const n = await queryset.update({ published: false })
    await this.messageUser(c, `${n} post(s) were unpublished.`, 'success')
  }
}

@admin.register(Tag)
export class TagAdmin extends ModelAdmin<Tag> {
  listDisplay = ['name', 'slug']
  searchFields = ['name']
  prepopulatedFields = { slug: ['name'] }
}

@admin.register(Comment)
export class CommentAdmin extends ModelAdmin<Comment> {
  listDisplay = ['name', 'post', 'approved', 'createdAt']
  listFilter = ['approved']
  searchFields = ['name', 'body']
}
