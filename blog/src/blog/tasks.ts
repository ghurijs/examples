// Background tasks of the blog app (@ghuri/tasks, Django 6.0's django.tasks). Named 'blog.<export name>'.
import { task } from '@ghuri/tasks'
import { Comment, Post } from './models'

/**
 * Publish a draft, e.g. at a set time: `await publishPost.using({ runAfter: new Date(at) }).enqueue(post.pk)`.
 * Returns the slug, so a client can poll the task result and then link to the post.
 */
export const publishPost = task(
  async (postId: number) => {
    const post = await Post.objects.get({ pk: postId })
    if (!post.published) {
      post.published = true
      await post.save()
    }
    return { slug: post.slug }
  },
  { maxAttempts: 3 },
)

/** Delete comments that were not approved, older than `days`. Runs nightly (see app.ts). */
export const purgeRejectedComments = task(async (days: number = 30) => {
  const cutoff = new Date(Date.now() - days * 86_400_000)
  const [deleted] = await Comment.objects.filter({ approved: false, createdAt__lt: cutoff }).delete()
  return { deleted }
})
